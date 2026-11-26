import io
import wave

import numpy as np
import pytest

from conftest import FakeEngine, make_wav
from msg_gw.bluebubbles import e164
from msg_gw.stt import AudioError, SpeechService, decode_wav


def test_decode_wav_mono():
    samples, rate = decode_wav(make_wav(0.25), max_seconds=5)
    assert rate == 16000
    assert samples.dtype == np.float32
    assert len(samples) == 4000


def test_decode_wav_downmixes_stereo():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(np.array([16384, 0] * 10, dtype="<i2").tobytes())
    samples, _ = decode_wav(buf.getvalue(), max_seconds=5)
    assert len(samples) == 10
    assert samples[0] == pytest.approx(0.25)


def test_decode_wav_rejects_too_long():
    with pytest.raises(AudioError):
        decode_wav(make_wav(2.0), max_seconds=1)


def test_decode_wav_rejects_8bit():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(16000)
        w.writeframes(b"\x80" * 100)
    with pytest.raises(AudioError):
        decode_wav(buf.getvalue(), max_seconds=5)


class FakeWhisper:
    name = "whisper"

    def __init__(self):
        self.langs = []

    def transcribe(self, samples, rate, language=""):
        self.langs.append(language)
        return "hola"


def test_routing_english_to_parakeet_other_to_whisper():
    whisper = FakeWhisper()
    svc = SpeechService(FakeEngine(), whisper)
    assert svc.transcribe(np.zeros(10, np.float32), 16000, "en").engine == "parakeet"
    assert svc.transcribe(np.zeros(10, np.float32), 16000, "es").engine == "whisper"
    assert svc.transcribe(np.zeros(10, np.float32), 16000, "auto").engine == "whisper"
    assert whisper.langs == ["es", ""]


def test_routing_falls_back_when_parakeet_missing():
    assert SpeechService(None, FakeWhisper()).transcribe(np.zeros(1, np.float32), 16000).engine == "whisper"


def test_no_engines_raises():
    with pytest.raises(RuntimeError):
        SpeechService(None, None).transcribe(np.zeros(1, np.float32), 16000)


@pytest.mark.parametrize("raw,expected", [
    ("(732) 555-1234", "+17325551234"),
    ("17325551234", "+17325551234"),
    ("+44 20 7946 0958", "+442079460958"),
    ("Dave@Example.com", "dave@example.com"),
])
def test_e164(raw, expected):
    assert e164(raw) == expected
