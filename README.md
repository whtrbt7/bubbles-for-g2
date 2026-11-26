# Bubbles for G2

Read and send **iMessage and SMS** on **Even Realities G2** glasses, through a small gateway on **your own Mac**.
No cloud service, no accounts with us: your messages go only between your iPhone, your Mac and your glasses.

- Inbox with newest conversations first, favorites, and paging through older chats
- Read threads, reply with quick replies or **on-device dictation** (Parakeet, runs on your Mac)
- New-message cards on the glasses while the app is open
- 5-second cancellable send countdown, so nothing goes out by accident
- Optional **"Hey Even"** commands ("read my messages", "text Jordan I'm on my way" → "send")

```
G2 glasses ⇄ Even App (iPhone) ──Tailscale──▶ your Mac: Bubbles gateway ──▶ BlueBubbles Server ──▶ Messages
```

## Install

You need: a Mac that stays on, signed in to Messages; [BlueBubbles Server](https://bluebubbles.app/downloads/);
[Tailscale](https://tailscale.com/download) on the Mac and iPhone; Even G2 glasses with the Even App.

1. Follow **[SETUP.md](SETUP.md)** steps 1–3 (Messages, BlueBubbles, Tailscale; about 15 minutes of clicking).
2. In Terminal on the Mac:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash
   ```
3. In the Even App, install **Bubbles for G2** from Even Hub, open it, and paste the URL and token the installer printed.

**Using Claude Code or another AI coding agent?** Tell it:
> Install Bubbles for G2 on this Mac by following https://github.com/whtrbt7/bubbles-for-g2/blob/main/AGENT_INSTALL.md

Something wrong? Run `~/Library/Application\ Support/BubblesG2/gateway/scripts/doctor.sh`. It checks every link and
prints the fix.

## Repository

| Path | What |
|---|---|
| `get.sh` | One-line bootstrap: downloads the latest release and runs the installer |
| `gateway/` | The Mac gateway (Python/FastAPI): BlueBubbles bridge, on-device speech-to-text, Even AI endpoint |
| `gateway/scripts/` | `install.sh`, `doctor.sh`, `uninstall.sh` |
| `app/` | The Even Hub app (TypeScript, Even Hub SDK) |
| `SETUP.md` / `AGENT_INSTALL.md` | Setup guides for people / for AI coding agents |
| `PRIVACY.md` | Privacy policy |

Development: `cd gateway && uv run pytest` · `cd app && npm install && npm test`.

## License & disclaimer

MIT. Bubbles for G2 is an independent project, not affiliated with Apple, Even Realities, BlueBubbles or Tailscale.
iMessage is a trademark of Apple Inc.
