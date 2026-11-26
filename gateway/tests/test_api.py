from urllib.parse import quote

import pytest

from conftest import AUTH, MOM, make_wav
from msg_gw.config import load_settings
from msg_gw.stt import SpeechService


def test_health_is_public_and_reports_bb_and_stt(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "bb": True, "stt": ["parakeet"]}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "t" * 32}])
def test_endpoints_require_token(client, headers):
    assert client.get("/chats", headers=headers).status_code == 401


def test_password_is_sent_to_bluebubbles_as_query_param(client, fake_bb):
    client.get("/chats", headers=AUTH)
    assert all(r.url.params.get("password") == "pw" for r in fake_bb.requests)


def test_chats_sorted_newest_first_and_invalid_guids_dropped(client):
    chats = client.get("/chats?limit=10", headers=AUTH).json()
    assert [c["lastAt"] for c in chats] == [9, 5, 3, 2]
    assert chats[-1] == {"guid": f"iMessage;-;{MOM}", "name": "Mom", "isGroup": False,
                         "lastText": "hi", "lastAt": 2, "fromMe": False, "unread": True}
    assert chats[0]["name"] == "Jordan Lee"


def test_chats_limit_applies_after_sorting(client):
    # Regression: BlueBubbles returned an arbitrary page when asked for a small limit.
    chats = client.get("/chats?limit=1", headers=AUTH).json()
    assert [c["lastText"] for c in chats] == ["newest sam"]


def test_chats_offset_pages_through(client):
    page2 = client.get("/chats?limit=2&offset=2", headers=AUTH).json()
    assert [c["lastAt"] for c in page2] == [3, 2]
    assert client.get("/chats?limit=2&offset=10", headers=AUTH).json() == []


def test_chat_list_is_cached_briefly(client, fake_bb):
    client.get("/chats", headers=AUTH)
    client.get("/chats?offset=1", headers=AUTH)
    assert sum(r.url.path == "/api/v1/chat/query" for r in fake_bb.requests) == 1


def test_messages_sorted_oldest_first_without_reactions(client):
    guid = quote(f"iMessage;-;{MOM}", safe="")
    msgs = client.get(f"/chats/{guid}/messages", headers=AUTH).json()
    assert [m["text"] for m in msgs] == ["early", "later"]
    assert msgs[0]["sender"] == "Mom"


def test_messages_rejects_invalid_guid(client):
    assert client.get("/chats/evil%22guid/messages", headers=AUTH).status_code == 400


def test_messages_passes_before_cursor(client, fake_bb):
    guid = quote(f"iMessage;-;{MOM}", safe="")
    client.get(f"/chats/{guid}/messages?before=99", headers=AUTH)
    msg_req = next(r for r in fake_bb.requests if r.url.path.endswith("/message"))
    assert msg_req.url.params.get("before") == "99"


def test_config_returns_quick_replies_and_named_favorites(client):
    body = client.get("/config", headers=AUTH).json()
    assert body["favorites"] == [{"name": "Mom", "address": MOM, "chatGuid": f"iMessage;-;{MOM}", "lastAt": 2}]
    assert "On my way" in body["quickReplies"]
    assert body["stt"] == ["parakeet"]


def test_favorites_by_name_use_latest_direct_chat_across_all_addresses(make_client):
    client = make_client(G2_FAVORITES=f"{MOM},jordan  LEE,Nobody Here")
    favs = client.get("/favorites", headers=AUTH).json()
    assert [f["name"] for f in favs] == ["Mom", "jordan LEE"]  # configured order and spelling kept; unknown skipped
    assert favs[1]["chatGuid"] == "iMessage;-;+12015550101"  # newer than her email chat, group chat ignored
    assert favs[1]["address"] == "+12015550101"


def test_favorite_without_chat_still_listed(make_client):
    client = make_client(G2_FAVORITES="+15559990000")
    assert client.get("/favorites", headers=AUTH).json() == [
        {"name": "+15559990000", "address": "+15559990000", "chatGuid": None, "lastAt": 0}]


def test_contacts_search(client):
    assert client.get("/contacts?q=mom", headers=AUTH).json() == [{"name": "Mom", "address": "+1 (732) 5551234"}]


def test_send_to_chat(client, fake_bb):
    resp = client.post("/send", headers=AUTH, json={"chatGuid": f"iMessage;-;{MOM}", "text": " On my way "})
    assert resp.json() == {"ok": True, "messageGuid": "sent-1"}
    body = fake_bb.bodies("/api/v1/message/text")[0]
    assert body["chatGuid"] == f"iMessage;-;{MOM}"
    assert body["message"] == "On my way"
    assert body["method"] == "apple-script"
    assert body["tempGuid"].startswith("g2-")


def test_send_to_address_reuses_existing_chat(client, fake_bb):
    client.post("/send", headers=AUTH, json={"address": "(732) 555-1234", "text": "hey"})
    assert fake_bb.bodies("/api/v1/message/text")[0]["chatGuid"] == f"iMessage;-;{MOM}"
    assert fake_bb.bodies("/api/v1/chat/new") == []


def test_send_to_new_address_creates_chat(client, fake_bb):
    client.post("/send", headers=AUTH, json={"address": "new@example.com", "text": "hello"})
    body = fake_bb.bodies("/api/v1/chat/new")[0]
    assert body["addresses"] == ["new@example.com"]
    assert body["service"] == "iMessage"


@pytest.mark.parametrize("payload", [
    {"text": "x"},
    {"chatGuid": f"iMessage;-;{MOM}", "address": MOM, "text": "x"},
    {"chatGuid": 'iMessage;-;+1"; do shell script "x', "text": "x"},
    {"address": "not an address!", "text": "x"},
    {"chatGuid": f"iMessage;-;{MOM}", "text": "   "},
])
def test_send_validation(client, payload):
    assert client.post("/send", headers=AUTH, json=payload).status_code in (400, 422)


def test_send_rate_limited(make_client):
    client = make_client(G2_SEND_LIMIT_PER_MIN="2")
    payload = {"chatGuid": f"iMessage;-;{MOM}", "text": "x"}
    codes = [client.post("/send", headers=AUTH, json=payload).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_bluebubbles_down_returns_502(client, fake_bb):
    fake_bb.fail = True
    assert client.get("/chats", headers=AUTH).status_code == 502
    assert client.get("/health").json()["bb"] is False


def test_stt_transcribes_wav(client):
    resp = client.post("/stt", headers={**AUTH, "Content-Type": "audio/wav"}, content=make_wav(0.5))
    assert resp.status_code == 200
    assert resp.json()["text"] == "heard 8000 samples at 16000"
    assert resp.json()["engine"] == "parakeet"


def test_stt_rejects_garbage(client):
    assert client.post("/stt", headers=AUTH, content=b"not a wav").status_code == 400


def test_stt_rejects_bad_lang(client):
    assert client.post("/stt?lang=../x", headers=AUTH, content=make_wav()).status_code == 422


def test_stt_unavailable_without_engines(make_client):
    client = make_client(speech=SpeechService(None, None))
    assert client.post("/stt", headers=AUTH, content=make_wav()).status_code == 503


def test_settings_require_strong_token():
    with pytest.raises(RuntimeError):
        load_settings({"BB_PASSWORD": "pw", "G2_MSG_TOKEN": "short"})
    with pytest.raises(RuntimeError):
        load_settings({"G2_MSG_TOKEN": "t" * 32})


def test_updates_returns_incoming_since_oldest_first(client):
    body = client.get("/updates?since=0", headers=AUTH).json()
    assert body["latest"] == 9
    assert [(m["name"], m["sender"], m["text"]) for m in body["messages"]] == [
        ("Mom", "Mom", "hi"),
        ("Jordan Lee", "Jordan Lee", "older sam"),
        ("Family", "Mom", "group"),
    ]  # the newest chat (9) is from me, so it is not a notification
    assert body["messages"][2]["isGroup"] is True


def test_updates_filters_by_since(client):
    body = client.get("/updates?since=3", headers=AUTH).json()
    assert [m["at"] for m in body["messages"]] == [5]
    assert client.get("/updates?since=99", headers=AUTH).json() == {"messages": [], "latest": 99}


def test_updates_requires_since_and_token(client):
    assert client.get("/updates", headers=AUTH).status_code == 422
    assert client.get("/updates?since=0").status_code == 401


def _ask(client, text, token="t" * 32):
    return client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                       json={"model": "openclaw", "messages": [{"role": "user", "content": text}]})


def test_agent_endpoint_requires_token(client):
    assert _ask(client, "read my messages", token="nope").status_code == 401


def test_agent_accepts_separate_agent_token(make_client):
    client = make_client(G2_AGENT_TOKEN="a" * 32)
    resp = _ask(client, "help", token="a" * 32)
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["role"] == "assistant"


def test_agent_compose_confirm_sends_via_bluebubbles(make_client, fake_bb):
    client = make_client(G2_FAVORITES="Jordan Lee")
    staged = _ask(client, "Hey Even text Jordan on my way").json()["choices"][0]["message"]["content"]
    assert staged.startswith('Send to Jordan Lee: "on my way"')
    assert fake_bb.bodies("/api/v1/message/text") == []
    done = _ask(client, "send it").json()["choices"][0]["message"]["content"]
    assert done == 'Sent to Jordan Lee: "on my way"'
    sent = fake_bb.bodies("/api/v1/message/text")
    assert [(b["chatGuid"], b["message"]) for b in sent] == [("iMessage;-;+12015550101", "on my way")]


def test_agent_reads_new_messages(client):
    content = _ask(client, "any new messages").json()["choices"][0]["message"]["content"]
    assert content == "No new messages in the last day."  # fake timestamps are decades old


def test_agent_tolerates_garbage_body(client):
    resp = client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {'t' * 32}"}, content=b"not json")
    assert resp.status_code == 200
