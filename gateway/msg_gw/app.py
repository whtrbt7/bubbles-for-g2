"""HTTP API consumed by the G2 Messages Even Hub app."""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .agent import Agent, People, Person, completion, hud, last_user_text
from .bluebubbles import BlueBubblesClient, BlueBubblesError
from .config import Settings
from .favorites import FavoritesError, FavoritesStore, favorite_names, resolve_favorites
from .shaping import (ContactBook, is_valid_address, is_valid_chat_guid, shape_chat, shape_incoming,
                      shape_message)
from .stt import AudioError, SpeechService, decode_wav

log = logging.getLogger("msg_gw")
CONTACTS_TTL_S = 600
CHATS_TTL_S = 4.0
MAX_CHATS = 1000
MAX_UPDATES = 10
RATE_WINDOW_S = 60.0


class SendRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    chatGuid: str | None = None
    address: str | None = None


class ContactCache:
    """Contact cards (refreshed every few minutes) with favorite names applied on top."""

    def __init__(self, client: BlueBubblesClient, favorites: FavoritesStore) -> None:
        self._client = client
        self._favorites = favorites
        self._base = ContactBook.empty()
        self._book = ContactBook.empty()
        self._applied: tuple[int, int] = (-1, -1)
        self._loaded_at = 0.0
        self._generation = 0
        self._lock = asyncio.Lock()

    async def get(self) -> ContactBook:
        if time.monotonic() - self._loaded_at >= CONTACTS_TTL_S:
            async with self._lock:
                if time.monotonic() - self._loaded_at >= CONTACTS_TTL_S:
                    try:
                        self._base = ContactBook.from_contacts(await self._client.contacts())
                        self._loaded_at = time.monotonic()
                        self._generation += 1
                    except BlueBubblesError:
                        log.warning("Contact refresh failed; using previous contact book")
        key = (self._generation, self._favorites.version)
        if key != self._applied:
            self._book = self._base.with_names(favorite_names(self._favorites.get(), self._base))
            self._applied = key
        return self._book


class ChatCache:
    """All chats, newest first. BlueBubbles applies `sort` after `limit`, so we fetch everything and sort here."""

    def __init__(self, client: BlueBubblesClient) -> None:
        self._client = client
        self._chats: list[dict] = []
        self._loaded_at = -CHATS_TTL_S
        self._lock = asyncio.Lock()

    async def get(self) -> list[dict]:
        async with self._lock:
            if time.monotonic() - self._loaded_at >= CHATS_TTL_S:
                raw = await self._client.list_chats(MAX_CHATS)
                self._chats = sorted(
                    (c for c in raw if is_valid_chat_guid(c.get("guid", ""))),
                    key=lambda c: -((c.get("lastMessage") or {}).get("dateCreated") or 0),
                )
                self._loaded_at = time.monotonic()
        return self._chats

    def invalidate(self) -> None:
        self._loaded_at = -CHATS_TTL_S


class SendLimiter:
    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._sent: deque[float] = deque()

    def check(self) -> None:
        now = time.monotonic()
        while self._sent and now - self._sent[0] > RATE_WINDOW_S:
            self._sent.popleft()
        if len(self._sent) >= self._per_minute:
            raise HTTPException(429, "Send rate limit reached; wait a minute")
        self._sent.append(now)


def create_app(settings: Settings, bb: BlueBubblesClient, speech: SpeechService | None) -> FastAPI:
    favorites_store = FavoritesStore(settings.favorites, settings.favorites_file)
    contacts = ContactCache(bb, favorites_store)
    chat_cache = ChatCache(bb)
    limiter = SendLimiter(settings.send_limit_per_min)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await bb.aclose()

    app = FastAPI(title="msg-gw", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def require_token(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not token or not secrets.compare_digest(token, settings.api_token):
            raise HTTPException(401, "Invalid or missing token")

    auth = [Depends(require_token)]

    def require_agent_token(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        valid = [t for t in (settings.agent_token, settings.api_token) if t]
        if not token or not any(secrets.compare_digest(token, t) for t in valid):
            raise HTTPException(401, "Invalid or missing token")

    async def agent_send(person: Person, text: str) -> None:
        limiter.check()
        if person.chat_guid:
            await bb.send_text(person.chat_guid, text)
        else:
            await bb.send_to_address(person.address, text)
        chat_cache.invalidate()
        log.info("Agent sent message (%d chars)", len(text))

    async def agent_messages(guid: str) -> list[dict]:
        raw = await bb.messages(guid, 8)
        return sorted((m for m in raw if not m.get("associatedMessageType")), key=lambda m: m.get("dateCreated") or 0)

    agent = Agent(send=agent_send, messages=agent_messages)

    def bb_failure(exc: BlueBubblesError) -> HTTPException:
        log.warning("BlueBubbles error: %s", exc)
        return HTTPException(502, "iMac Messages bridge unavailable")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "bb": await bb.ping(), "stt": speech.engines if speech else []}

    @app.get("/config", dependencies=auth)
    async def config() -> dict[str, Any]:
        book = await contacts.get()
        try:
            all_chats = await chat_cache.get()
        except BlueBubblesError:
            all_chats = []
        favorites = resolve_favorites(favorites_store.get(), book, all_chats)
        return {"quickReplies": list(settings.quick_replies), "favorites": favorites,
                "stt": speech.engines if speech else []}

    @app.get("/favorites", dependencies=auth)
    async def favorites() -> list[dict[str, Any]]:
        try:
            all_chats = await chat_cache.get()
        except BlueBubblesError as exc:
            raise bb_failure(exc) from exc
        return resolve_favorites(favorites_store.get(), await contacts.get(), all_chats)

    @app.put("/favorites", dependencies=auth)
    async def save_favorites(request: Request) -> list[dict[str, Any]]:
        try:
            body = await request.json()
            favorites_store.set(body.get("items") if isinstance(body, dict) else None)
        except (ValueError, FavoritesError) as exc:
            raise HTTPException(400, str(exc) if isinstance(exc, FavoritesError) else "Invalid JSON") from exc
        except OSError as exc:
            log.warning("Saving favorites failed: %s", type(exc).__name__)
            raise HTTPException(500, "Could not save favorites") from exc
        log.info("Favorites updated (%d)", len(favorites_store.get()))
        return await favorites()

    @app.get("/chats", dependencies=auth)
    async def chats(limit: int = Query(8, ge=1, le=25), offset: int = Query(0, ge=0, le=MAX_CHATS)) -> list[dict[str, Any]]:
        try:
            all_chats = await chat_cache.get()
        except BlueBubblesError as exc:
            raise bb_failure(exc) from exc
        book = await contacts.get()
        return [shape_chat(c, book) for c in all_chats[offset:offset + limit]]

    @app.post("/v1/chat/completions", dependencies=[Depends(require_agent_token)])
    async def even_ai(request: Request) -> dict[str, Any]:
        """Even AI Agent Configuration endpoint (OpenAI chat.completions shape, latest utterance only)."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        utterance = last_user_text(body if isinstance(body, dict) else {})[:500]
        try:
            all_chats = await chat_cache.get()
            book = await contacts.get()
            people = People(book, resolve_favorites(favorites_store.get(), book, all_chats), all_chats)
            reply = await agent.handle(utterance, people, book, all_chats, int(time.time() * 1000))
        except BlueBubblesError as exc:
            log.warning("Agent BlueBubbles error: %s", exc)
            reply = "Your iMac Messages bridge is offline right now."
        except HTTPException as exc:  # rate limit
            reply = hud(str(exc.detail))
        log.info("Agent handled utterance (%d chars in, %d out)", len(utterance), len(reply))
        return completion(reply)

    @app.get("/updates", dependencies=auth)
    async def updates(since: int = Query(..., ge=0)) -> dict[str, Any]:
        """Incoming messages newer than `since` (ms), oldest first, plus the newest timestamp seen."""
        try:
            all_chats = await chat_cache.get()
        except BlueBubblesError as exc:
            raise bb_failure(exc) from exc
        book = await contacts.get()
        fresh = [i for i in (shape_incoming(c, book) for c in all_chats) if i and i["at"] > since]
        latest = max((((c.get("lastMessage") or {}).get("dateCreated") or 0) for c in all_chats), default=0)
        return {"messages": sorted(fresh, key=lambda m: m["at"])[-MAX_UPDATES:], "latest": max(latest, since)}

    @app.get("/chats/{guid}/messages", dependencies=auth)
    async def messages(guid: str, limit: int = Query(20, ge=1, le=50),
                       before: int | None = Query(None, ge=0)) -> list[dict[str, Any]]:
        if not is_valid_chat_guid(guid):
            raise HTTPException(400, "Invalid chat id")
        try:
            raw = await bb.messages(guid, limit, before)
        except BlueBubblesError as exc:
            raise bb_failure(exc) from exc
        book = await contacts.get()
        shaped = [m for m in (shape_message(r, book) for r in raw) if m]
        return sorted(shaped, key=lambda m: m["at"])

    @app.get("/contacts", dependencies=auth)
    async def search_contacts(q: str = Query(..., min_length=1, max_length=80)) -> list[dict[str, str]]:
        return (await contacts.get()).search(q)

    @app.post("/send", dependencies=auth)
    async def send(req: SendRequest) -> dict[str, Any]:
        text = req.text.strip()
        if not text:
            raise HTTPException(400, "Empty message")
        if bool(req.chatGuid) == bool(req.address):
            raise HTTPException(400, "Provide exactly one of chatGuid or address")
        if req.chatGuid and not is_valid_chat_guid(req.chatGuid):
            raise HTTPException(400, "Invalid chat id")
        if req.address and not is_valid_address(req.address):
            raise HTTPException(400, "Invalid address")
        limiter.check()
        try:
            if req.chatGuid:
                result = await bb.send_text(req.chatGuid, text)
            else:
                result = await bb.send_to_address(req.address or "", text)
        except BlueBubblesError as exc:
            raise bb_failure(exc) from exc
        chat_cache.invalidate()
        log.info("Sent message (%d chars)", len(text))
        return {"ok": True, "messageGuid": (result or {}).get("guid")}

    @app.post("/stt", dependencies=auth)
    async def stt(request: Request, lang: str = Query("en", pattern=r"^[a-z]{2}$|^auto$")) -> dict[str, Any]:
        if speech is None or not speech.engines:
            raise HTTPException(503, "Speech-to-text not available")
        body = await request.body()
        if len(body) > settings.max_audio_seconds * 16000 * 2 + 1024:
            raise HTTPException(413, "Audio too large")
        try:
            samples, rate = decode_wav(body, settings.max_audio_seconds)
        except AudioError as exc:
            raise HTTPException(400, str(exc)) from exc
        result = await asyncio.to_thread(speech.transcribe, samples, rate, lang)
        log.info("STT %s %dms (%.1fs audio)", result.engine, result.ms, len(samples) / rate)
        return {"text": result.text, "engine": result.engine, "ms": result.ms}

    return app
