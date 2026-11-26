"""Resolve configured favorites (contact names or raw addresses) to people and their latest 1:1 chat."""
from __future__ import annotations

import json
import logging
import os
import tempfile
from typing import Any, Mapping, Sequence

log = logging.getLogger("msg_gw.favorites")
MAX_FAVORITES = 15
MAX_ITEM_LEN = 80


class FavoritesError(ValueError):
    pass


def clean_items(items: Sequence[Any]) -> tuple[str, ...]:
    """Validate a user-supplied favorites list: strings, printable, deduped (case-insensitive), capped."""
    if not isinstance(items, (list, tuple)):
        raise FavoritesError("items must be a list")
    if len(items) > MAX_FAVORITES:
        raise FavoritesError(f"At most {MAX_FAVORITES} favorites")
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            raise FavoritesError("Each favorite must be a name or phone/email")
        value = " ".join(item.split())
        if not value or len(value) > MAX_ITEM_LEN or not value.isprintable():
            raise FavoritesError("Invalid favorite")
        if value.lower() not in seen:
            seen.add(value.lower())
            out.append(value)
    return tuple(out)


class FavoritesStore:
    """Favorites edited from the phone, persisted as JSON (mode 600). Falls back to the env list until first save."""

    def __init__(self, initial: Sequence[str], path: str = "") -> None:
        self._path = path
        self._items = tuple(initial)
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    self._items = clean_items(json.load(fh))
            except (OSError, ValueError):
                log.warning("Ignoring unreadable favorites file; using configured defaults")
        self.version = 0

    def get(self) -> tuple[str, ...]:
        return self._items

    def set(self, items: Sequence[Any]) -> tuple[str, ...]:
        cleaned = clean_items(items)
        if self._path:
            folder = os.path.dirname(self._path) or "."
            fd, tmp = tempfile.mkstemp(dir=folder, prefix=".favorites-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(list(cleaned), fh)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self._path)
            except OSError:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
        self._items = cleaned
        self.version += 1
        return cleaned

from .shaping import GROUP_STYLE, ContactBook, address_key, is_valid_address, is_valid_chat_guid


def _latest_direct_chat(keys: set[str], chats: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """`chats` must already be sorted newest first."""
    for chat in chats:
        participants = chat.get("participants") or []
        if chat.get("style") == GROUP_STYLE or len(participants) != 1:
            continue
        if not is_valid_chat_guid(chat.get("guid", "")):
            continue
        if address_key(participants[0].get("address", "")) in keys:
            return chat
    return None


def favorite_names(spec: Sequence[str], book: ContactBook) -> dict[str, str]:
    """address → configured favorite's card name, so favorites win when a number sits on two cards."""
    out: dict[str, str] = {}
    for item in spec:
        entry = None if is_valid_address(item) else book.find(item)
        if entry:
            out.update({a: " ".join(item.split()) for a in entry.addresses or (entry.address,)})
    return out


def resolve_favorites(spec: Sequence[str], book: ContactBook,
                      chats: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in spec:
        if is_valid_address(item):
            name, addresses = book.name_for(item), (item,)
        else:
            entry = book.find(item)
            if entry is None:
                continue
            name, addresses = " ".join(item.split()), entry.addresses or (entry.address,)
        chat = _latest_direct_chat({address_key(a) for a in addresses}, chats)
        address = (chat["participants"][0]["address"] if chat else addresses[0])
        out.append({"name": name, "address": address, "chatGuid": chat["guid"] if chat else None,
                    "lastAt": ((chat or {}).get("lastMessage") or {}).get("dateCreated") or 0})
    return out  # keep the order the user configured
