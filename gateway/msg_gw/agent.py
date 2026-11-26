"""Even AI "Agent Configuration" backend: spoken commands for iMessage, answered in HUD-sized plain text.

Even sends only the latest utterance (no history), so a pending send is held here and confirmed by a follow-up
utterance ("send" / "cancel"). Nothing is ever sent without that confirmation.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Awaitable, Callable, Mapping, Sequence

from .favorites import _latest_direct_chat
from .shaping import ContactBook, address_key, message_text, shape_incoming

MAX_REPLY_CHARS = 350
PENDING_TTL_S = 120.0
NEW_WINDOW_MS = 24 * 3600 * 1000
FIRST_NAME_MIN_RATIO = 0.8

HELP = ('I handle your iMessages. Try: "read my messages", "what did Jordan say", '
        '"text Jordan I\'m on my way", or "reply on my way". Then say "send" or "cancel".')

_FILLER = re.compile(r"^(?:hey|ok|okay)?\s*(?:even[,.]?\s*)?(?:please\s+|can you\s+|could you\s+|would you\s+)*", re.I)
_CONFIRM = re.compile(r"^(?:yes|yeah|yep|yup|sure|send|send it|send that|send the message|confirm|go ahead|do it)"
                      r"(?: please)?$")
_CANCEL = re.compile(r"^(?:no|nope|cancel|cancel it|don'?t send( it)?|stop|never ?mind|forget it)(?: please)?$")
_COMPOSE = re.compile(r"^(?:send (?:a |an )?(?:text|message|imessage|sms) to|send (?:a |an )?(?:text|message) for|"
                      r"text|message|imessage|tell|send)\s+(?P<rest>.+)$")
_REPLY = re.compile(r"^(?:reply|respond|answer|write back|text back)(?: back)?(?: to (?:that|them|her|him|it|"
                    r"the last (?:one|message|text)))?(?:\s+(?:with|saying|that|:))?\s*(?P<body>.*)$")
_FROM_PERSON = re.compile(r"^(?:what did|what has|whats|what's|what is)\s+(?P<who>.+?)\s+(?:say|said|text|texted|send|"
                          r"sent|write|wrote|saying)\b.*$|^(?:read|show|check|get)(?: me)?(?: my)?(?: the)?(?: last| latest"
                          r"| recent)?\s+(?:messages|message|texts|text)\s+(?:from|with)\s+(?P<who2>.+)$")
_NEW = re.compile(r"\b(?:messages|message|texts|text|imessages)\b")
_NEW_VERB = re.compile(r"^(?:read|check|show|any|do i have|did i get|what are|whats|what's|get|new|latest|recent|unread)")
_BODY_LEAD = re.compile(r"^(?:that|saying|say|to say|and say|:)\s+", re.I)


@dataclass(frozen=True)
class Person:
    name: str
    chat_guid: str | None
    address: str


@dataclass(frozen=True)
class Pending:
    person: Person
    text: str
    expires: float


def normalize(utterance: str) -> str:
    text = utterance.strip().strip('"').strip()
    text = _FILLER.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _plain(text: str) -> str:
    return " ".join(text.lower().replace("’", "'").rstrip(".!?").split())


def hud(text: str, limit: int = MAX_REPLY_CHARS) -> str:
    """Firmware-safe plain text: no markdown/emoji/smart punctuation, cut on a word boundary."""
    out = (text.replace("…", "...").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
           .replace("—", "-").replace("–", "-"))
    out = re.sub(r"[*_`#>]+", "", out)
    out = "".join(ch for ch in out if ch == "\n" or (ch.isprintable() and ord(ch) < 0x2000))
    out = re.sub(r"[ \t]+", " ", out).strip()
    if len(out) <= limit:
        return out
    cut = out[: limit - 3].rsplit(" ", 1)[0]
    return f"{cut}..."


class People:
    """Resolves spoken names to people: favorites first (full or first name), then contact cards."""

    def __init__(self, book: ContactBook, favorites: Sequence[Mapping[str, Any]], chats: Sequence[Mapping[str, Any]]):
        self._book = book
        self._favorites = favorites
        self._chats = chats

    def _from_favorite(self, fav: Mapping[str, Any]) -> Person:
        return Person(name=fav["name"], chat_guid=fav.get("chatGuid"), address=fav["address"])

    def _from_entry(self, name: str) -> Person | None:
        entry = self._book.find(name)
        if entry is None:
            return None
        chat = _latest_direct_chat({address_key(a) for a in entry.addresses or (entry.address,)}, self._chats)
        address = chat["participants"][0]["address"] if chat else entry.address
        return Person(name=entry.name, chat_guid=chat["guid"] if chat else None, address=address)

    def _exact(self, said: str) -> Person | None:
        for fav in self._favorites:
            if _plain(fav["name"]) == said:
                return self._from_favorite(fav)
        return self._from_entry(said)

    def _first_name(self, said: str) -> Person | None:
        """One spoken word against favorites' first names: exact, else a single close (typo-tolerant) match."""
        def first(f: Mapping[str, Any]) -> str:
            return _plain(f["name"]).split()[0]
        exact = [f for f in self._favorites if first(f) == said]
        if len(exact) == 1:
            return self._from_favorite(exact[0])
        close = [f for f in self._favorites if SequenceMatcher(None, said, first(f)).ratio() >= FIRST_NAME_MIN_RATIO]
        return self._from_favorite(close[0]) if len(close) == 1 else None

    def _loose(self, said: str) -> Person | None:
        """Any contact card, only when the spoken words are very close to one name."""
        close = [h for h in self._book.search(said, limit=3)
                 if SequenceMatcher(None, said, _plain(h["name"])).ratio() >= FIRST_NAME_MIN_RATIO
                 or (len(said.split()) == 1 and SequenceMatcher(None, said, _plain(h["name"]).split()[0]).ratio() >= 0.9)]
        return self._from_entry(close[0]["name"]) if len(close) == 1 else None

    def match(self, spoken: str) -> Person | None:
        said = _plain(spoken)
        if not said:
            return None
        return self._exact(said) or (self._first_name(said) if len(said.split()) == 1 else None) or self._loose(said)

    def split(self, rest: str) -> tuple[Person | None, str]:
        """Find who the message is for at the start of `rest`; the remainder is the message body.

        Tiers, strictest first, so a loose match never swallows words of the message:
        exact full name (longest first) → one-word first name among favorites → close contact match (1-2 words).
        """
        words = rest.split()
        tail = lambda n: " ".join(words[n:])  # noqa: E731
        for n in range(min(4, len(words)), 0, -1):
            person = self._exact(_plain(" ".join(words[:n])))
            if person:
                return person, tail(n)
        if words:
            person = self._first_name(_plain(words[0]))
            if person:
                return person, tail(1)
        for n in (2, 1):
            if len(words) >= n:
                person = self._loose(_plain(" ".join(words[:n])))
                if person:
                    return person, tail(n)
        return None, rest


SendFn = Callable[[Person, str], Awaitable[None]]
MessagesFn = Callable[[str], Awaitable[list[dict]]]


class Agent:
    def __init__(self, send: SendFn, messages: MessagesFn, clock: Callable[[], float] = time.monotonic) -> None:
        self._send = send
        self._messages = messages
        self._clock = clock
        self._pending: Pending | None = None

    async def handle(self, utterance: str, people: People, book: ContactBook,
                     chats: Sequence[Mapping[str, Any]], now_ms: int) -> str:
        text = normalize(utterance)
        plain = _plain(text)
        if not plain:
            return HELP
        if _CONFIRM.match(plain):
            return await self._confirm()
        if _CANCEL.match(plain):
            had = self._take_pending()
            return f"Cancelled. Nothing sent to {had.person.name}." if had else "Nothing to cancel."
        reply = _REPLY.match(plain)
        if reply and plain.split()[0] in ("reply", "respond", "answer", "write", "text") and reply.group("body"):
            return self._compose_reply(text, reply, chats, book)
        who = _FROM_PERSON.match(plain)
        if who:
            return await self._read_person(who.group("who") or who.group("who2") or "", people)
        if _NEW.search(plain) and _NEW_VERB.match(plain):
            return self._read_new(chats, book, now_ms)
        compose = _COMPOSE.match(text.lower())
        if compose:
            return self._compose(text[len(text) - len(compose.group("rest")):], people)
        return HELP  # no general-purpose AI: anything else gets the command list

    # ---- sending (always two-step) ----

    def _take_pending(self) -> Pending | None:
        pending, self._pending = self._pending, None
        if pending and pending.expires < self._clock():
            return None
        return pending

    def _stage(self, person: Person, body: str) -> str:
        body = _BODY_LEAD.sub("", body.strip()).strip()
        if not body:
            return f'What should I say to {person.name}? Say it all at once, like "text {person.name.split()[0]} on my way".'
        self._pending = Pending(person=person, text=body, expires=self._clock() + PENDING_TTL_S)
        return hud(f'Send to {person.name}: "{body}"? Say "send" to confirm or "cancel".')

    async def _confirm(self) -> str:
        pending = self._take_pending()
        if pending is None:
            return "Nothing waiting to send. Say something like \"text Jordan I'm on my way\"."
        await self._send(pending.person, pending.text)
        return hud(f'Sent to {pending.person.name}: "{pending.text}"')

    def _compose(self, rest: str, people: People) -> str:
        person, body = people.split(rest)
        if person is None:
            return hud(f'I couldn\'t find who "{rest.split()[0]}" is. Try their full name as it appears in contacts.')
        return self._stage(person, body)

    def _compose_reply(self, text: str, match: re.Match, chats: Sequence[Mapping[str, Any]], book: ContactBook) -> str:
        latest = next((i for i in (shape_incoming(c, book) for c in chats) if i), None)
        if latest is None:
            return "No recent message to reply to."
        person = Person(name=latest["name"], chat_guid=latest["chatGuid"], address="")
        body = text[len(text) - len(match.group("body")):] if match.group("body") else ""
        return self._stage(person, body)

    # ---- reading ----

    def _read_new(self, chats: Sequence[Mapping[str, Any]], book: ContactBook, now_ms: int) -> str:
        recent = [i for i in (shape_incoming(c, book) for c in chats) if i and now_ms - i["at"] <= NEW_WINDOW_MS]
        if not recent:
            return "No new messages in the last day."
        lines = []
        for item in recent[:3]:
            who = f'{item["sender"]} in {item["name"]}' if item["isGroup"] and item["sender"] else item["name"]
            lines.append(f"{who}: {item['text']}")
        more = f"\n+{len(recent) - 3} more" if len(recent) > 3 else ""
        return hud("\n".join(lines) + more)

    async def _read_person(self, spoken: str, people: People) -> str:
        person = people.match(spoken)
        if person is None:
            return hud(f'I couldn\'t find "{spoken}" in your contacts.')
        if not person.chat_guid:
            return f"No conversation with {person.name} yet."
        msgs = (await self._messages(person.chat_guid))[-3:]
        if not msgs:
            return f"No messages with {person.name} yet."
        first = person.name.split()[0]
        lines = [f'{"You" if m.get("isFromMe") else first}: {message_text(m)}' for m in msgs]
        return hud("\n".join(lines))


def completion(content: str) -> dict[str, Any]:
    """OpenAI chat.completion envelope, as the Even app expects."""
    return {"id": f"g2msg-{int(time.time() * 1000)}", "object": "chat.completion", "created": int(time.time()),
            "model": "openclaw",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}


def last_user_text(body: Mapping[str, Any]) -> str:
    for msg in reversed(body.get("messages") or []):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(p.get("text", "") for p in content if isinstance(p, Mapping))
    return ""
