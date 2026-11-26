"""Resolve configured favorites (contact names or raw addresses) to people and their latest 1:1 chat."""
from __future__ import annotations

from typing import Any, Mapping, Sequence

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
