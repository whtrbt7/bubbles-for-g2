"""Gateway configuration, loaded once from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_QUICK_REPLIES = (
    "On my way",
    "Running 10 min late",
    "Can't talk, will call later",
    "Yes",
    "No",
    "Thanks!",
)


def _split(value: str, sep: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(sep) if part.strip())


@dataclass(frozen=True)
class Settings:
    bb_url: str
    bb_password: str
    api_token: str
    quick_replies: tuple[str, ...] = DEFAULT_QUICK_REPLIES
    favorites: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ("*",)
    parakeet_dir: str = ""
    whisper_dir: str = ""
    stt_threads: int = 4
    send_limit_per_min: int = 10
    max_text_len: int = 2000
    max_audio_seconds: int = 60
    agent_token: str = ""  # Even AI Agent Configuration token (separate from the app token)


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    missing = [k for k in ("BB_PASSWORD", "G2_MSG_TOKEN") if not env.get(k)]
    if missing:
        raise RuntimeError(f"Missing required env: {', '.join(missing)}")
    if len(env["G2_MSG_TOKEN"]) < 24:
        raise RuntimeError("G2_MSG_TOKEN must be at least 24 characters")
    replies = _split(env.get("G2_QUICK_REPLIES", ""), "|") or DEFAULT_QUICK_REPLIES
    return Settings(
        bb_url=env.get("BB_URL", "http://127.0.0.1:1234").rstrip("/"),
        bb_password=env["BB_PASSWORD"],
        api_token=env["G2_MSG_TOKEN"],
        quick_replies=replies,
        favorites=_split(env.get("G2_FAVORITES", ""), ","),
        allowed_origins=_split(env.get("G2_ALLOWED_ORIGINS", "*"), ",") or ("*",),
        parakeet_dir=env.get("STT_PARAKEET_DIR", ""),
        whisper_dir=env.get("STT_WHISPER_DIR", ""),
        stt_threads=int(env.get("STT_THREADS", "4")),
        send_limit_per_min=int(env.get("G2_SEND_LIMIT_PER_MIN", "10")),
        agent_token=env.get("G2_AGENT_TOKEN", ""),
    )
