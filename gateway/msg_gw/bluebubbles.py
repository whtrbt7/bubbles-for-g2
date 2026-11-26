"""Thin async client for the BlueBubbles server REST API (v1)."""
from __future__ import annotations

import re
import uuid
from typing import Any
from urllib.parse import quote

import httpx

SEND_METHOD = "apple-script"  # Private API helper is not connected on the iMac
SERVICES = ("iMessage", "SMS")


class BlueBubblesError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def e164(address: str) -> str:
    """Best-effort US-centric E.164 for phone numbers; emails pass through."""
    value = address.strip()
    if "@" in value:
        return value.lower()
    digits = re.sub(r"\D", "", value)
    if value.startswith("+"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return f"+{digits}"


class BlueBubblesClient:
    def __init__(self, base_url: str, password: str, transport: httpx.AsyncBaseTransport | None = None,
                 timeout: float = 15.0) -> None:
        self._password = password
        self._http = httpx.AsyncClient(base_url=base_url, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, *, params: dict | None = None,
                       json: dict | None = None) -> Any:
        merged = {**(params or {}), "password": self._password}
        try:
            resp = await self._http.request(method, path, params=merged, json=json)
        except httpx.HTTPError as exc:
            raise BlueBubblesError(f"BlueBubbles unreachable: {type(exc).__name__}") from exc
        if resp.status_code >= 400:
            raise BlueBubblesError(f"BlueBubbles {method} {path.split('?')[0]} -> {resp.status_code}",
                                   status=resp.status_code)
        return resp.json().get("data")

    async def ping(self) -> bool:
        try:
            await self._request("GET", "/api/v1/server/info")
            return True
        except BlueBubblesError:
            return False

    async def list_chats(self, limit: int) -> list[dict]:
        body = {"limit": limit, "offset": 0, "with": ["lastMessage", "participants"], "sort": "lastmessage"}
        return await self._request("POST", "/api/v1/chat/query", json=body) or []

    async def get_chat(self, guid: str) -> dict | None:
        try:
            return await self._request("GET", f"/api/v1/chat/{quote(guid, safe='')}",
                                       params={"with": "participants"})
        except BlueBubblesError as exc:
            if exc.status in (400, 404):
                return None
            raise

    async def messages(self, guid: str, limit: int, before: int | None = None) -> list[dict]:
        params: dict[str, Any] = {"limit": limit, "sort": "DESC", "with": "handle,attachment"}
        if before:
            params["before"] = before
        path = f"/api/v1/chat/{quote(guid, safe='')}/message"
        return await self._request("GET", path, params=params) or []

    async def contacts(self) -> list[dict]:
        return await self._request("GET", "/api/v1/contact") or []

    async def send_text(self, chat_guid: str, text: str) -> dict:
        body = {"chatGuid": chat_guid, "tempGuid": f"g2-{uuid.uuid4()}", "message": text,
                "method": SEND_METHOD}
        return await self._request("POST", "/api/v1/message/text", json=body) or {}

    async def send_to_address(self, address: str, text: str) -> dict:
        """Send to a phone/email: reuse an existing 1:1 chat, else create one."""
        target = e164(address)
        for service in SERVICES:
            guid = f"{service};-;{target}"
            if await self.get_chat(guid):
                return await self.send_text(guid, text)
        body = {"addresses": [target], "message": text, "service": SERVICES[0], "method": SEND_METHOD,
                "tempGuid": f"g2-{uuid.uuid4()}"}
        return await self._request("POST", "/api/v1/chat/new", json=body) or {}
