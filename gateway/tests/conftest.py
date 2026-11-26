from __future__ import annotations

import io
import json
import wave
from dataclasses import dataclass, field

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from msg_gw.app import create_app
from msg_gw.bluebubbles import BlueBubblesClient
from msg_gw.config import load_settings
from msg_gw.stt import SpeechService

TOKEN = "t" * 32
AUTH = {"Authorization": f"Bearer {TOKEN}"}
MOM = "+17325551234"


@dataclass
class FakeBB:
    """Records requests and serves canned BlueBubbles responses."""
    requests: list[httpx.Request] = field(default_factory=list)
    existing_chats: set[str] = field(default_factory=lambda: {f"iMessage;-;{MOM}"})
    fail: bool = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail:
            return httpx.Response(500, json={"status": 500})
        path = request.url.path
        if path == "/api/v1/server/info":
            return _ok({"server_version": "1.9.9"})
        if path == "/api/v1/contact":
            return _ok([
                {"displayName": "Mom", "phoneNumbers": [{"address": "+1 (732) 5551234"}], "emails": []},
                {"displayName": "Jordan Lee", "phoneNumbers": [{"address": "+1 (201) 555-0101"}],
                 "emails": [{"address": "jordan@example.com"}]},
            ])
        if path == "/api/v1/chat/query":
            # Real BlueBubbles sorts *after* limiting, so serve chats deliberately out of order.
            return _ok([
                {"guid": "iMessage;-;jordan@example.com", "displayName": "", "style": 45,
                 "participants": [{"address": "jordan@example.com"}],
                 "lastMessage": {"text": "older sam", "isFromMe": False, "dateCreated": 3, "dateRead": 4}},
                {"guid": f"iMessage;-;{MOM}", "displayName": "", "style": 45,
                 "participants": [{"address": MOM}],
                 "lastMessage": {"text": "hi", "isFromMe": False, "dateCreated": 2, "dateRead": None}},
                {"guid": "bad guid; rm -rf", "participants": [], "lastMessage": None},
                {"guid": "iMessage;-;+12015550101", "displayName": "", "style": 45,
                 "participants": [{"address": "+12015550101"}],
                 "lastMessage": {"text": "newest sam", "isFromMe": True, "dateCreated": 9, "dateRead": None}},
                {"guid": "iMessage;+;chat777", "displayName": "Family", "style": 43,
                 "participants": [{"address": MOM}, {"address": "+12015550101"}],
                 "lastMessage": {"text": "group", "isFromMe": False, "dateCreated": 5, "dateRead": None,
                                 "handle": {"address": MOM}}},
            ])
        if path.endswith("/message") and path.startswith("/api/v1/chat/"):
            return _ok([
                {"guid": "m2", "text": "later", "isFromMe": True, "dateCreated": 20, "handle": None},
                {"guid": "r1", "text": "Loved", "associatedMessageType": "love", "dateCreated": 15},
                {"guid": "m1", "text": "early", "isFromMe": False, "dateCreated": 10, "handle": {"address": MOM}},
            ])
        if path.startswith("/api/v1/chat/") and request.method == "GET":
            guid = request.url.raw_path.decode().split("/api/v1/chat/")[1].split("?")[0]
            from urllib.parse import unquote
            return _ok({"guid": unquote(guid)}) if unquote(guid) in self.existing_chats else httpx.Response(404, json={})
        if path in ("/api/v1/message/text", "/api/v1/chat/new"):
            return _ok({"guid": "sent-1"})
        return httpx.Response(404, json={})

    def bodies(self, path: str) -> list[dict]:
        return [json.loads(r.content) for r in self.requests if r.url.path == path]


def _ok(data) -> httpx.Response:
    return httpx.Response(200, json={"status": 200, "data": data})


class FakeEngine:
    name = "parakeet"

    def transcribe(self, samples, rate):
        return f"heard {len(samples)} samples at {rate}"


def make_wav(seconds: float = 0.5, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.zeros(int(seconds * rate), dtype="<i2").tobytes())
    return buf.getvalue()


@pytest.fixture
def fake_bb() -> FakeBB:
    return FakeBB()


@pytest.fixture
def make_client(fake_bb):
    def _make(speech: SpeechService | None = SpeechService(FakeEngine(), None), **env) -> TestClient:
        settings = load_settings({"BB_PASSWORD": "pw", "G2_MSG_TOKEN": TOKEN,
                                  "G2_FAVORITES": MOM, **env})
        bb = BlueBubblesClient("http://bb.test", "pw", transport=httpx.MockTransport(fake_bb.handler))
        return TestClient(create_app(settings, bb, speech))
    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()
