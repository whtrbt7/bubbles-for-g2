"""Pure functions that turn BlueBubbles payloads into compact HUD-friendly dicts."""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Mapping

GROUP_STYLE = 43
OBJECT_REPLACEMENT = "￼"
MIN_SEARCH_SCORE = 0.55
MAX_SEARCH_RESULTS = 5

# chatGuid is interpolated into AppleScript by BlueBubbles (see bluebubbles-server#860),
# so only allow the exact shapes Messages produces.
_CHAT_GUID_RE = re.compile(r"^(iMessage|SMS|RCS|any);[-+];[A-Za-z0-9@._+\-]{1,128}$")
_PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,}$")


def is_valid_chat_guid(guid: str) -> bool:
    return bool(_CHAT_GUID_RE.match(guid or ""))


def is_valid_address(address: str) -> bool:
    cleaned = re.sub(r"[\s()\-.]", "", address or "")
    return bool(_PHONE_RE.match(cleaned) or _EMAIL_RE.match((address or "").strip()))


def address_key(address: str) -> str:
    """Normalize a phone/email so contact-card and handle formats compare equal."""
    value = (address or "").strip()
    if "@" in value:
        return value.lower()
    digits = re.sub(r"\D", "", value)
    return digits[-10:] if len(digits) >= 10 else digits


def _contact_name(contact: Mapping[str, Any]) -> str:
    display = (contact.get("displayName") or "").strip()
    if display:
        return display
    parts = [contact.get("firstName") or "", contact.get("lastName") or ""]
    return " ".join(p.strip() for p in parts if p and p.strip())


def _addresses(contact: Mapping[str, Any]) -> list[str]:
    entries = list(contact.get("phoneNumbers") or []) + list(contact.get("emails") or [])
    out = []
    for entry in entries:
        address = entry.get("address") if isinstance(entry, Mapping) else entry
        if address:
            out.append(str(address))
    return out


@dataclass(frozen=True)
class ContactEntry:
    name: str
    address: str
    addresses: tuple[str, ...] = ()


@dataclass(frozen=True)
class ContactBook:
    names_by_key: Mapping[str, str]
    entries: tuple[ContactEntry, ...]

    @classmethod
    def from_contacts(cls, contacts: list[Mapping[str, Any]]) -> "ContactBook":
        names: dict[str, str] = {}
        entries: list[ContactEntry] = []
        for contact in contacts:
            name = _contact_name(contact)
            addresses = _addresses(contact)
            if not name or not addresses:
                continue
            for address in addresses:
                names.setdefault(address_key(address), name)
            entries.append(ContactEntry(name=name, address=addresses[0], addresses=tuple(addresses)))
        return cls(names_by_key=names, entries=tuple(entries))

    @classmethod
    def empty(cls) -> "ContactBook":
        return cls(names_by_key={}, entries=())

    def name_for(self, address: str) -> str:
        return self.names_by_key.get(address_key(address), address)

    def with_names(self, names: Mapping[str, str]) -> "ContactBook":
        """New book where `names` (address → display name) win over contact-card collisions."""
        overrides = {address_key(a): n for a, n in names.items()}
        return ContactBook(names_by_key={**self.names_by_key, **overrides}, entries=self.entries)

    def find(self, name: str) -> ContactEntry | None:
        """Exact (case-insensitive) name match; merges duplicate cards with the same name."""
        wanted = " ".join(name.lower().split())
        matches = [e for e in self.entries if e.name.lower() == wanted]
        if not matches:
            return None
        merged = tuple(dict.fromkeys(a for e in matches for a in (e.addresses or (e.address,))))
        return ContactEntry(name=matches[0].name, address=merged[0], addresses=merged)

    def search(self, query: str, limit: int = MAX_SEARCH_RESULTS) -> list[dict[str, str]]:
        q = " ".join(query.lower().split())
        if not q:
            return []
        scored = []
        for entry in self.entries:
            score = _match_score(q, entry.name.lower())
            if score >= MIN_SEARCH_SCORE:
                scored.append((score, entry.name, entry))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [{"name": e.name, "address": e.address} for _, _, e in scored[:limit]]


def _match_score(query: str, name: str) -> float:
    if name == query:
        return 2.0
    tokens = name.split()
    if name.startswith(query) or any(t.startswith(query) for t in tokens):
        return 1.5
    whole = SequenceMatcher(None, query, name).ratio()
    best_token = max((SequenceMatcher(None, query, t).ratio() for t in tokens), default=0.0)
    return max(whole, best_token)


def _attachment_label(attachment: Mapping[str, Any], is_audio: bool) -> str:
    if is_audio:
        return "[audio]"
    mime = (attachment.get("mimeType") or "").lower()
    for prefix, label in (("image/", "[photo]"), ("video/", "[video]"), ("audio/", "[audio]")):
        if mime.startswith(prefix):
            return label
    return "[file]"


def message_text(message: Mapping[str, Any]) -> str:
    text = (message.get("text") or "").strip()
    attachments = message.get("attachments") or []
    is_audio = bool(message.get("isAudioMessage"))
    labels = [_attachment_label(a or {}, is_audio) for a in attachments]
    if labels:
        body = text.replace(OBJECT_REPLACEMENT, "").strip()
        joined = " ".join(dict.fromkeys(labels))
        return f"{body} {joined}".strip()
    return text or "[message]"


def _first_name(full: str) -> str:
    return full.split()[0] if full and not full.startswith("+") else full


def shape_chat(chat: Mapping[str, Any], book: ContactBook) -> dict[str, Any]:
    participants = chat.get("participants") or []
    is_group = chat.get("style") == GROUP_STYLE or len(participants) > 1
    name = (chat.get("displayName") or "").strip()
    if not name:
        names = [book.name_for(p.get("address", "")) for p in participants]
        if is_group:
            name = ", ".join(_first_name(n) for n in names) or "Group"
        else:
            name = names[0] if names else (chat.get("chatIdentifier") or "Unknown")
    last = chat.get("lastMessage") or {}
    from_me = bool(last.get("isFromMe"))
    return {
        "guid": chat.get("guid", ""),
        "name": name,
        "isGroup": is_group,
        "lastText": message_text(last) if last else "",
        "lastAt": last.get("dateCreated") or 0,
        "fromMe": from_me,
        "unread": bool(last) and not from_me and not last.get("dateRead"),
    }


def shape_incoming(chat: Mapping[str, Any], book: ContactBook) -> dict[str, Any] | None:
    """A chat's last message as a notification, or None if it's ours, a tapback, or missing."""
    last = chat.get("lastMessage") or {}
    if not last or last.get("isFromMe") or last.get("associatedMessageType"):
        return None
    summary = shape_chat(chat, book)
    handle = (last.get("handle") or {}).get("address", "")
    sender = book.name_for(handle) if handle else ("" if summary["isGroup"] else summary["name"])
    return {"chatGuid": summary["guid"], "name": summary["name"], "isGroup": summary["isGroup"],
            "sender": sender, "text": summary["lastText"], "at": summary["lastAt"]}


def shape_message(message: Mapping[str, Any], book: ContactBook) -> dict[str, Any] | None:
    if message.get("associatedMessageType"):
        return None  # tapback reactions add noise on a tiny HUD
    from_me = bool(message.get("isFromMe"))
    handle = message.get("handle") or {}
    sender = "You" if from_me else book.name_for(handle.get("address", "")) or "Unknown"
    return {
        "guid": message.get("guid", ""),
        "fromMe": from_me,
        "sender": sender,
        "text": message_text(message),
        "at": message.get("dateCreated") or 0,
    }
