import pytest

from msg_gw.agent import HELP, MAX_REPLY_CHARS, Agent, People, completion, hud, last_user_text, normalize
from msg_gw.shaping import ContactBook

NOW_MS = 1_800_000_000_000
CONTACTS = [
    {"displayName": "Jordan Lee", "phoneNumbers": [{"address": "+12015550101"}], "emails": []},
    {"displayName": "Casey Lee", "phoneNumbers": [{"address": "+12015550102"}], "emails": []},
    {"displayName": "Morgan Diaz", "phoneNumbers": [{"address": "+12015550103"}], "emails": []},
    {"displayName": "Samuel Jones", "phoneNumbers": [{"address": "+12015550199"}], "emails": []},
]
FAVORITES = [
    {"name": "Jordan Lee", "address": "+12015550101", "chatGuid": "iMessage;-;+12015550101", "lastAt": 9},
    {"name": "Casey Lee", "address": "+12015550102", "chatGuid": "iMessage;-;+12015550102", "lastAt": 8},
    {"name": "Morgan Diaz", "address": "+12015550103", "chatGuid": None, "lastAt": 0},
]
CHATS = [
    {"guid": "iMessage;-;+12015550101", "style": 45, "participants": [{"address": "+12015550101"}],
     "lastMessage": {"text": "picking up the kids?", "isFromMe": False, "dateCreated": NOW_MS - 60_000}},
    {"guid": "iMessage;+;chat1", "style": 43, "displayName": "Family",
     "participants": [{"address": "+12015550101"}, {"address": "+12015550102"}],
     "lastMessage": {"text": "dinner at 7", "isFromMe": False, "dateCreated": NOW_MS - 120_000,
                     "handle": {"address": "+12015550102"}}},
    {"guid": "iMessage;-;+12015550102", "style": 45, "participants": [{"address": "+12015550102"}],
     "lastMessage": {"text": "ok", "isFromMe": True, "dateCreated": NOW_MS - 180_000}},
]


class Clock:
    t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def env():
    sent: list[tuple[str, str | None, str, str]] = []
    clock = Clock()

    async def send(person, text):
        sent.append((person.name, person.chat_guid, person.address, text))

    async def messages(guid):
        return [{"text": "are you coming?", "isFromMe": False}, {"text": "yes, 10 min", "isFromMe": True},
                {"text": "picking up the kids?", "isFromMe": False}]

    book = ContactBook.from_contacts(CONTACTS)
    agent = Agent(send=send, messages=messages, clock=clock)

    async def say(text: str) -> str:
        return await agent.handle(text, People(book, FAVORITES, CHATS), book, CHATS, NOW_MS)

    return say, sent, clock


async def test_compose_then_confirm_sends(env):
    say, sent, _ = env
    reply = await say("Hey Even, text Jordan I'm on my way")
    assert reply == 'Send to Jordan Lee: "I\'m on my way"? Say "send" to confirm or "cancel".'
    assert sent == []
    assert (await say("Send.")) == 'Sent to Jordan Lee: "I\'m on my way"'
    assert sent == [("Jordan Lee", "iMessage;-;+12015550101", "+12015550101", "I'm on my way")]


async def test_nothing_sends_without_confirmation(env):
    say, sent, _ = env
    await say("text Jordan I'm on my way")
    assert "cancel" in (await say("cancel")).lower()
    assert (await say("send")).startswith("Nothing waiting")
    assert sent == []


async def test_pending_send_expires(env):
    say, sent, clock = env
    await say("text Casey be there soon")
    clock.t += 121
    assert (await say("yes")).startswith("Nothing waiting")
    assert sent == []


@pytest.mark.parametrize("utterance,name,body", [
    ("send a text to Jordan Lee saying running late", "Jordan Lee", "running late"),
    ("message casey that dinner is ready", "Casey Lee", "dinner is ready"),
    ("tell Morgan Diaz see you saturday", "Morgan Diaz", "see you saturday"),
    ("text Jordon hi", "Jordan Lee", "hi"),  # transcription typo still matches a favorite
])
async def test_compose_variants(env, utterance, name, body):
    say, _, _ = env
    assert await say(utterance) == f'Send to {name}: "{body}"? Say "send" to confirm or "cancel".'


async def test_favorite_without_chat_sends_to_address(env):
    say, sent, _ = env
    await say("text Morgan see you soon")
    await say("yes")
    assert sent == [("Morgan Diaz", None, "+12015550103", "see you soon")]


async def test_unknown_recipient(env):
    say, sent, _ = env
    assert "couldn't find" in (await say("text Zebulon hello")).lower()
    assert sent == []


async def test_missing_body_asks_for_full_command(env):
    say, _, _ = env
    assert (await say("text Jordan")).startswith("What should I say to Jordan Lee?")


async def test_reply_targets_latest_incoming_chat(env):
    say, sent, _ = env
    assert (await say("reply on my way")).startswith('Send to Jordan Lee: "on my way"')
    await say("go ahead")
    assert sent[0][1] == "iMessage;-;+12015550101"


async def test_read_new_messages(env):
    say, _, _ = env
    reply = await say("read my messages")
    assert reply == "Jordan Lee: picking up the kids?\nCasey Lee in Family: dinner at 7"


async def test_read_from_person(env):
    say, _, _ = env
    for q in ("what did Jordan say", "read messages from Jordan"):
        assert await say(q) == "Jordan: are you coming?\nYou: yes, 10 min\nJordan: picking up the kids?"


async def test_read_from_person_without_chat(env):
    say, _, _ = env
    assert await say("what did Morgan say") == "No conversation with Morgan Diaz yet."


async def test_unrelated_question_gets_help(env):
    say, _, _ = env
    assert await say("what's the weather tomorrow") == HELP


def test_hud_caps_length_on_word_boundary():
    out = hud("word " * 200)
    assert len(out) <= MAX_REPLY_CHARS
    assert out.endswith("...")


def test_normalize_strips_wake_words():
    assert normalize("Hey Even, please text Sam hi") == "text Sam hi"


def test_last_user_text_and_completion_shape():
    body = {"model": "openclaw", "messages": [{"role": "user", "content": "read my messages"}]}
    assert last_user_text(body) == "read my messages"
    assert last_user_text({"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}) == "hi"
    out = completion("ok")
    assert out["choices"][0]["message"] == {"role": "assistant", "content": "ok"}
    assert out["object"] == "chat.completion"


def test_people_prefers_unique_first_name_among_favorites():
    book = ContactBook.from_contacts(CONTACTS)
    people = People(book, FAVORITES, CHATS)
    assert people.match("jordan").name == "Jordan Lee"  # not Samuel Jones
    person, rest = people.split("Jordan Lee I love you")
    assert person.name == "Jordan Lee" and rest == "I love you"
