"""Speech-to-text engines (sherpa-onnx): Parakeet for English, Whisper for other languages."""
from __future__ import annotations

import io
import logging
import os
import threading
import time
import wave
from dataclasses import dataclass
from typing import Protocol

import numpy as np

log = logging.getLogger("msg_gw.stt")
TARGET_RATE = 16000


class AudioError(ValueError):
    pass


@dataclass(frozen=True)
class Transcript:
    text: str
    engine: str
    ms: int


class Engine(Protocol):
    name: str

    def transcribe(self, samples: np.ndarray, rate: int) -> str: ...


def decode_wav(data: bytes, max_seconds: int) -> tuple[np.ndarray, int]:
    """Return mono float32 samples in [-1, 1] and the sample rate."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
            frames = wav.getnframes()
            if width != 2:
                raise AudioError("Only 16-bit PCM WAV is supported")
            if frames > rate * max_seconds:
                raise AudioError(f"Audio longer than {max_seconds}s")
            raw = wav.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise AudioError(f"Invalid WAV: {exc}") from exc
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def _find(model_dir: str, *candidates: str) -> str:
    for name in candidates:
        path = os.path.join(model_dir, name)
        if os.path.exists(path):
            return path
    raise FileNotFoundError(f"None of {candidates} in {model_dir}")


def _run(recognizer, samples: np.ndarray, rate: int) -> str:
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


class ParakeetEngine:
    name = "parakeet"

    def __init__(self, model_dir: str, threads: int) -> None:
        import sherpa_onnx

        self._rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=_find(model_dir, "encoder.int8.onnx", "encoder.onnx"),
            decoder=_find(model_dir, "decoder.int8.onnx", "decoder.onnx"),
            joiner=_find(model_dir, "joiner.int8.onnx", "joiner.onnx"),
            tokens=_find(model_dir, "tokens.txt"),
            num_threads=threads,
            model_type="nemo_transducer",
        )

    def transcribe(self, samples: np.ndarray, rate: int) -> str:
        return _run(self._rec, samples, rate)


class WhisperEngine:
    name = "whisper"

    def __init__(self, model_dir: str, threads: int, language: str = "") -> None:
        import sherpa_onnx

        files = os.listdir(model_dir)
        enc = next((f for f in files if f.endswith("encoder.int8.onnx")), None)
        dec = next((f for f in files if f.endswith("decoder.int8.onnx")), None)
        tok = next((f for f in files if f.endswith("tokens.txt")), None)
        if not (enc and dec and tok):
            raise FileNotFoundError(f"Whisper int8 model files missing in {model_dir}")
        self._model_dir, self._threads = model_dir, threads
        self._paths = (os.path.join(model_dir, enc), os.path.join(model_dir, dec), os.path.join(model_dir, tok))
        self._by_lang: dict[str, object] = {}
        self._sherpa = sherpa_onnx
        self._recognizer(language)

    def _recognizer(self, language: str):
        if language not in self._by_lang:
            enc, dec, tok = self._paths
            self._by_lang[language] = self._sherpa.OfflineRecognizer.from_whisper(
                encoder=enc, decoder=dec, tokens=tok, language=language, task="transcribe",
                num_threads=self._threads,
            )
        return self._by_lang[language]

    def transcribe(self, samples: np.ndarray, rate: int, language: str = "") -> str:
        return _run(self._recognizer(language), samples, rate)


class SpeechService:
    """Routes English to Parakeet and everything else (or Parakeet-missing) to Whisper."""

    def __init__(self, parakeet: Engine | None, whisper: WhisperEngine | None) -> None:
        self._parakeet = parakeet
        self._whisper = whisper
        self._lock = threading.Lock()  # one decode at a time on the 4-core iMac

    @classmethod
    def from_dirs(cls, parakeet_dir: str, whisper_dir: str, threads: int) -> "SpeechService":
        parakeet = whisper = None
        if parakeet_dir:
            try:
                parakeet = ParakeetEngine(parakeet_dir, threads)
            except Exception:
                log.exception("Parakeet failed to load from %s", parakeet_dir)
        if whisper_dir:
            try:
                whisper = WhisperEngine(whisper_dir, threads)
            except Exception:
                log.exception("Whisper failed to load from %s", whisper_dir)
        return cls(parakeet, whisper)

    @property
    def engines(self) -> list[str]:
        return [e.name for e in (self._parakeet, self._whisper) if e is not None]

    def transcribe(self, samples: np.ndarray, rate: int, lang: str = "en") -> Transcript:
        lang = (lang or "en").lower()
        start = time.perf_counter()
        with self._lock:
            if lang == "en" and self._parakeet is not None:
                text, name = self._parakeet.transcribe(samples, rate), self._parakeet.name
            elif self._whisper is not None:
                whisper_lang = "" if lang == "auto" else lang
                text, name = self._whisper.transcribe(samples, rate, whisper_lang), self._whisper.name
            elif self._parakeet is not None:
                text, name = self._parakeet.transcribe(samples, rate), self._parakeet.name
            else:
                raise RuntimeError("No STT engine loaded")
        return Transcript(text=text, engine=name, ms=int((time.perf_counter() - start) * 1000))
