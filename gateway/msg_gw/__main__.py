"""Entry point: python -m msg_gw.

Binds G2_MSG_HOST (default loopback). With G2_TLS_CERT/G2_TLS_KEY set it serves HTTPS directly
(used on the iMac, bound to its Tailscale IP with a `tailscale cert` certificate) and exits after
G2_RESTART_HOURS so launchd restarts it and run.sh refreshes the certificate.
"""
from __future__ import annotations

import logging
import os
import threading

import uvicorn

from .app import create_app
from .bluebubbles import BlueBubblesClient
from .config import load_settings
from .stt import SpeechService

log = logging.getLogger("msg_gw")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # httpx logs full request URLs at INFO, and BlueBubbles takes its password as a query param.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    settings = load_settings()
    bb = BlueBubblesClient(settings.bb_url, settings.bb_password)
    speech = SpeechService.from_dirs(settings.parakeet_dir, settings.whisper_dir, settings.stt_threads)
    log.info("STT engines loaded: %s", speech.engines or "none")

    cert, key = os.environ.get("G2_TLS_CERT", ""), os.environ.get("G2_TLS_KEY", "")
    config = uvicorn.Config(
        create_app(settings, bb, speech),
        host=os.environ.get("G2_MSG_HOST", "127.0.0.1"),
        port=int(os.environ.get("G2_MSG_PORT", "8787")),
        access_log=False,
        proxy_headers=False,
        ssl_certfile=cert or None,
        ssl_keyfile=key or None,
    )
    server = uvicorn.Server(config)
    restart_hours = float(os.environ.get("G2_RESTART_HOURS", "24" if cert else "0"))
    if restart_hours > 0:
        timer = threading.Timer(restart_hours * 3600, lambda: setattr(server, "should_exit", True))
        timer.daemon = True
        timer.start()
        log.info("Scheduled restart in %.0fh (certificate refresh)", restart_hours)
    server.run()


if __name__ == "__main__":
    main()
