# Bubbles for G2: privacy policy

Last updated: 2026-11-25

Bubbles for G2 has **no servers of its own**. The app on your phone talks only to the gateway you install on **your own
Mac**, over **your own private Tailscale network**. The developer never receives your messages, contacts, audio or usage.

## Permissions the app requests

| Permission | Why | Where the data goes |
|---|---|---|
| **Network** (`*.ts.net` only) | Fetch conversations, send messages, transcribe dictation | Only to the gateway URL you enter, which is your own Mac on your Tailscale network. No other host is contacted. |
| **Glasses microphone** | Dictating replies and new messages, and only while you hold to talk or choose "Dictate" | The recording is sent to your own Mac, transcribed there on-device (Parakeet / Whisper), then discarded. It is never stored or sent anywhere else. |

## Data handled on your Mac

- **Messages and contacts** are read from your Mac's Messages database through BlueBubbles Server, shaped for the
  glasses display, and returned to your phone. The gateway keeps no copy beyond a few seconds of in-memory cache.
- **Sending:** text you confirm is passed to Messages on your Mac, which sends it as iMessage or SMS.
- **Logs** (`~/Library/Logs/BubblesG2.log`) record events and sizes only, never message text, contact details,
  passwords or tokens.
- **Favorites** you pick on the phone are saved on your Mac (`config/favorites.json`, readable only by your user).
- **Secrets** (BlueBubbles password, gateway tokens) live in a file readable only by your macOS user.

## Data on your phone

The Even App stores the gateway URL and token you enter, locally, so you don't re-enter them. Demo mode uses built-in
made-up conversations, stays on the phone and sends nothing.

## Third parties

- **Even Realities** (Even App, glasses) and **Tailscale** (network) handle data under their own privacy policies.
- If you enable the optional **Even AI** integration, Even's speech recognition transcribes what you say before it
  reaches your gateway. The gateway's Even AI handling is rule-based and uses no external AI service.
- Bubbles for G2 contains no analytics, ads or tracking.

## Removing your data

Run `uninstall.sh` on the Mac to delete the gateway, its tokens, certificate and model. Remove the app in the Even App to
clear the saved URL and token.

Contact: open an issue at https://github.com/whtrbt7/bubbles-for-g2/issues
