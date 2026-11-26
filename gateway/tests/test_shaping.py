import pytest

from msg_gw.shaping import (
    ContactBook,
    address_key,
    is_valid_chat_guid,
    is_valid_address,
    message_text,
    shape_chat,
    shape_incoming,
    shape_message,
)

CONTACTS = [
    {"displayName": "Mom Lee", "firstName": "Mom", "lastName": "Lee",
     "phoneNumbers": [{"address": "+1 (732) 5551234", "id": 1}], "emails": []},
    {"displayName": "", "firstName": "Dave", "lastName": "Park",
     "phoneNumbers": [], "emails": [{"address": "Dave@Example.com", "id": 2}]},
    {"displayName": "Lisa Wong", "firstName": "Lisa", "lastName": "Wong",
     "phoneNumbers": [{"address": "732-555-9999", "id": 3}], "emails": []},
]


@pytest.fixture
def book() -> ContactBook:
    return ContactBook.from_contacts(CONTACTS)


def test_address_key_normalizes_phone_to_last_ten_digits():
    assert address_key("+1 (732) 5551234") == "7325551234"
    assert address_key("+17325551234") == "7325551234"


def test_address_key_lowercases_email():
    assert address_key(" Dave@Example.com ") == "dave@example.com"


def test_contact_book_resolves_handles(book):
    assert book.name_for("+17325551234") == "Mom Lee"
    assert book.name_for("dave@example.com") == "Dave Park"
    assert book.name_for("+19998887777") == "+19998887777"


def test_with_names_overrides_card_collisions(book):
    # Same number on two cards: the first card wins by default; a favorite override must win instead.
    dup = ContactBook.from_contacts(CONTACTS + [{"displayName": "Avery Lee", "phoneNumbers": [{"address": "+17325551234"}]}])
    assert dup.name_for("+17325551234") == "Mom Lee"
    assert dup.with_names({"+17325551234": "Avery Lee"}).name_for("(732) 555-1234") == "Avery Lee"
    assert dup.name_for("+17325551234") == "Mom Lee"  # original untouched


def test_find_merges_duplicate_cards_and_ignores_case(book):
    merged = ContactBook.from_contacts(CONTACTS + [{"displayName": "lisa wong", "emails": [{"address": "l@w.com"}]}])
    entry = merged.find("Lisa Wong")
    assert entry is not None
    assert set(entry.addresses) == {"732-555-9999", "l@w.com"}
    assert merged.find("Nobody") is None


def test_contact_search_ranks_prefix_matches_first(book):
    hits = book.search("lisa")
    assert hits[0]["name"] == "Lisa Wong"
    assert hits[0]["address"] == "732-555-9999"


def test_contact_search_tolerates_typos(book):
    assert book.search("davy park")[0]["name"] == "Dave Park"


def test_contact_search_empty_query_returns_nothing(book):
    assert book.search("  ") == []


@pytest.mark.parametrize("guid", [
    "iMessage;-;+17325551234",
    "SMS;-;+17325551234",
    "iMessage;+;chat123456789012",
    "any;-;dave@example.com",
])
def test_valid_chat_guids(guid):
    assert is_valid_chat_guid(guid)


@pytest.mark.parametrize("guid", [
    "iMessage;-;+1732\"; do shell script \"rm -rf ~",
    "iMessage;-;",
    "Foo;-;+1732",
    "iMessage;-;a b",
    "x" * 300,
])
def test_invalid_chat_guids(guid):
    assert not is_valid_chat_guid(guid)


def test_valid_addresses():
    assert is_valid_address("+17325551234")
    assert is_valid_address("dave@example.com")
    assert not is_valid_address("hello\"world")
    assert not is_valid_address("123")


def test_message_text_placeholders():
    assert message_text({"text": "hi"}) == "hi"
    assert message_text({"text": "", "attachments": [{"mimeType": "image/jpeg"}]}) == "[photo]"
    assert message_text({"text": None, "attachments": [{"mimeType": "video/mp4"}]}) == "[video]"
    assert message_text({"text": "￼", "attachments": [{"mimeType": "application/pdf"}]}) == "[file]"
    assert message_text({"text": "look ￼", "attachments": [{"mimeType": "image/png"}]}) == "look [photo]"
    assert message_text({"text": None, "isAudioMessage": True, "attachments": [{}]}) == "[audio]"
    assert message_text({"text": None}) == "[message]"


def test_shape_chat_single(book):
    chat = {
        "guid": "iMessage;-;+17325551234", "displayName": "", "style": 45,
        "participants": [{"address": "+17325551234"}],
        "lastMessage": {"text": "running late?", "isFromMe": False, "dateCreated": 1000, "dateRead": None},
    }
    shaped = shape_chat(chat, book)
    assert shaped == {
        "guid": "iMessage;-;+17325551234", "name": "Mom Lee", "isGroup": False,
        "lastText": "running late?", "lastAt": 1000, "fromMe": False, "unread": True,
    }


def test_shape_chat_group_uses_first_names(book):
    chat = {
        "guid": "iMessage;+;chat99", "displayName": "", "style": 43,
        "participants": [{"address": "+17325551234"}, {"address": "dave@example.com"}],
        "lastMessage": {"text": "ok", "isFromMe": True, "dateCreated": 5, "dateRead": None},
    }
    shaped = shape_chat(chat, book)
    assert shaped["name"] == "Mom, Dave"
    assert shaped["isGroup"] is True
    assert shaped["unread"] is False


def test_shape_chat_prefers_display_name(book):
    chat = {"guid": "iMessage;+;chat1", "displayName": "Family", "style": 43,
            "participants": [], "lastMessage": None}
    shaped = shape_chat(chat, book)
    assert shaped["name"] == "Family"
    assert shaped["lastText"] == ""


def test_shape_message(book):
    msg = {"guid": "m1", "text": "yo", "isFromMe": False, "dateCreated": 7,
           "handle": {"address": "dave@example.com"}}
    assert shape_message(msg, book) == {
        "guid": "m1", "fromMe": False, "sender": "Dave Park", "text": "yo", "at": 7,
    }


def test_shape_message_from_me(book):
    msg = {"guid": "m2", "text": "k", "isFromMe": True, "dateCreated": 8, "handle": None}
    assert shape_message(msg, book)["sender"] == "You"


def test_shape_message_skips_reactions(book):
    msg = {"guid": "m3", "text": "Loved “yo”", "isFromMe": False, "dateCreated": 9,
           "associatedMessageType": "love", "handle": {"address": "dave@example.com"}}
    assert shape_message(msg, book) is None


def test_shape_incoming_skips_mine_and_tapbacks(book):
    base = {"guid": "iMessage;-;+17325551234", "style": 45, "participants": [{"address": "+17325551234"}]}
    mine = {**base, "lastMessage": {"text": "k", "isFromMe": True, "dateCreated": 1}}
    tapback = {**base, "lastMessage": {"text": "Loved", "isFromMe": False, "associatedMessageType": "love", "dateCreated": 2}}
    theirs = {**base, "lastMessage": {"text": "yo", "isFromMe": False, "dateCreated": 3}}
    assert shape_incoming(mine, book) is None
    assert shape_incoming(tapback, book) is None
    assert shape_incoming({**base, "lastMessage": None}, book) is None
    assert shape_incoming(theirs, book) == {"chatGuid": "iMessage;-;+17325551234", "name": "Mom Lee",
                                            "isGroup": False, "sender": "Mom Lee", "text": "yo", "at": 3}
