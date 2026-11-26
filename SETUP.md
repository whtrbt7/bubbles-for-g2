# Bubbles for G2: setup guide

Read and send iMessages (and SMS) on Even Realities G2 glasses. Your messages travel only between your iPhone,
your Mac and your glasses, over your own private Tailscale network.

```
G2 glasses ⇄ Even App (iPhone) ──Tailscale──▶ your Mac: Bubbles gateway ──▶ BlueBubbles Server ──▶ Messages
```

Time: about 20 minutes, once.

## What you need

- A **Mac** that stays on and awake (Apple Silicon or Intel, macOS 11 or newer), with about 2 GB free.
- The **same Apple Account** signed in to Messages on the Mac and on your iPhone.
- **Even G2** glasses paired with the **Even App**.
- A free **Tailscale** account.

## 1. Messages on the Mac

1. Open **Messages** on the Mac and sign in with your Apple Account. Send yourself a test message.
2. On the **iPhone**: Settings → Apps → Messages → **Text Message Forwarding** → turn on your Mac.
   (Needed for green-bubble SMS; iMessage works without it.)
3. On the Mac: System Settings → **Energy** (or Battery → Options) → prevent automatic sleeping when the display is off.

## 2. BlueBubbles Server (reads and sends your messages)

1. Download **BlueBubbles Server** from https://bluebubbles.app/downloads/ and move it to Applications.
2. Open it and follow its setup. When macOS asks, grant:
   - **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access → BlueBubbles on)
   - **Automation → Messages** and **Accessibility** (so it can send)
3. In BlueBubbles **Settings**: set a **server password**, keep the port at **1234**, and set Proxy Service to
   **Dynamic DNS / none** (Bubbles uses Tailscale instead, so no public URL is needed).
4. Send a test message from the BlueBubbles window to confirm sending works.

macOS requires you to click these permission prompts yourself; no script can grant them.

## 3. Tailscale (private network between iPhone and Mac)

1. Install Tailscale on the **Mac** (https://tailscale.com/download/mac) and the **iPhone** (App Store); sign in to both
   with the same account.
2. In the Tailscale admin console → **DNS**: enable **MagicDNS** and **HTTPS Certificates**.
3. Keep the Tailscale VPN switched **on** on the iPhone whenever you use the glasses app.

## 4. Install the Bubbles gateway (one command)

In Terminal on the Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash
```

(Or download the latest release from https://github.com/whtrbt7/bubbles-for-g2/releases and run
`./gateway/scripts/install.sh` from the unzipped folder. Using an AI coding agent? Point it at
[AGENT_INSTALL.md](AGENT_INSTALL.md).)

It checks everything above, installs the gateway and its on-device speech model (about 650 MB), starts it in the
background, sets it to start at login, and finishes by printing your **Gateway URL** and copying your
**Gateway token** to the clipboard. Re-running it is safe (that's also how you update).

Options: `--with-whisper` adds dictation in languages other than English (+400 MB) · `--port 8443` changes the port.

## 5. Pair the glasses

1. In the Even App, install **Bubbles for G2** from Even Hub and open it on the phone.
2. Paste the **Gateway URL** and **Gateway token** from step 4 → **Save & connect**.
   The status line should read *Gateway OK · Messages bridge up*.
   Copying on the Mac and pasting on the iPhone (Universal Clipboard) only works for about 2 minutes. If you see
   *Gateway rejected the token*, copy it again and paste right away; don't pick a saved password the keyboard suggests.
3. Open Bubbles for G2 on the glasses.

## Using it

| On the glasses | Tap | Double-tap | Hold |
|---|---|---|---|
| Inbox | open chat · "+ New message" · "> Favorites" · "More..." | exit / previous page | Favorites |
| Chat | reply (quick replies or dictate) | back | dictate a reply |
| New-message card | open the chat | dismiss | dictate a reply |
| Send countdown (5 s) | | **cancel** | |

**Favorites:** in the Even App, open Bubbles for G2 → **Favorites**. Search your contacts, tap **Add**, use ▲ to
reorder and ✕ to remove (up to 15). Changes save to your Mac and show on the glasses right away (hold on the inbox).
They are stored in `~/Library/Application Support/BubblesG2/config/favorites.json`. `G2_FAVORITES` in the env file is
only the starting list, used until you first save from the phone.

**Try it first:** before your Mac is set up, tap the glasses on the "Not connected" screen (or **Try the demo** on the
phone page) to explore with made-up conversations. Nothing is sent in demo mode.

## Optional: "Hey Even" (Even AI)

Only for **Even Hub developer accounts** (the Agent Configuration menu is hidden otherwise).
Even App → Settings → Even AI → Agent Configuration:
- URL: your Gateway URL + `/v1/chat/completions`
- Token: `G2_AGENT_TOKEN` from the config file above

Then say "read my messages", "what did Jordan say", "text Jordan I'm on my way" → "send" or "cancel".
Nothing is sent without your spoken "send". While selected, this replaces Even AI for all questions.

## Troubleshooting

Run `~/Library/Application\ Support/BubblesG2/gateway/scripts/doctor.sh`. It checks every link (Messages, BlueBubbles, Tailscale, certificate, gateway,
speech model, reading conversations) and prints the fix for anything that fails.

| Symptom | Fix |
|---|---|
| Phone app: "Cannot reach the iMac / gateway" | Turn on Tailscale on the iPhone. |
| "Messages bridge is offline" | Open BlueBubbles on the Mac. |
| Green-bubble texts missing | iPhone: Text Message Forwarding → enable the Mac. |
| Dictation fails | `doctor.sh`; re-run `install.sh` to restore the model. |

## Uninstall

`~/Library/Application\ Support/BubblesG2/gateway/scripts/uninstall.sh` removes the gateway, its model, tokens and certificate. BlueBubbles and Tailscale stay
installed; remove them separately if you no longer need them.

## Privacy

- Messages are read from your own Mac and shown only on your glasses; nothing goes to a third-party server.
- Dictation runs on your Mac (Parakeet / Whisper via sherpa-onnx). Audio never leaves your devices.
- The gateway listens only on your private Tailscale address and requires a token. Logs never contain message text.
- Bubbles for G2 is not affiliated with Apple or Even Realities.
