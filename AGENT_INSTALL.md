# Bubbles for G2: install guide for AI coding agents

You are an AI coding agent (for example Claude Code) helping a user install Bubbles for G2 on their Mac.
Follow these steps in order. Each step has a **check** you run; do not continue until it passes.
Steps marked **USER** need the user's own clicks; macOS does not allow scripts to do them. Explain what to click, wait
for them to say it's done, then run the check.

Human-oriented version of the same steps: [SETUP.md](SETUP.md).

## Rules

- **Never print, log or paste secrets**: the BlueBubbles server password, `G2_MSG_TOKEN`, `G2_AGENT_TOKEN`, or anything
  from `~/Library/Application Support/BubblesG2/config/env`. To hand a token to the user, pipe it to `pbcopy`.
- **Never send a message** (BlueBubbles API, AppleScript, or the gateway's `/send`) unless the user explicitly asks.
- **Never read message content** to verify things; use the counts that `doctor.sh` prints.
- Ask before running anything with `--yes`, and before installing software (uv, Tailscale, BlueBubbles).
- Don't use `sudo`. Nothing here needs it.

## 0. Check the Mac

```bash
sw_vers -productVersion; uname -m; df -h ~ | tail -1
```
**Check:** macOS 11 or newer, at least 2 GB free. The Mac must stay on and awake; tell the user to disable automatic
sleep (System Settings → Energy / Battery → Options).

## 1. Messages (USER)

Ask the user to open **Messages** on the Mac, sign in with the same Apple Account as their iPhone, and send themselves a
test message. For SMS (green bubbles): iPhone → Settings → Apps → Messages → **Text Message Forwarding** → enable this Mac.

**Check:** `test -e ~/Library/Messages && echo ok`

## 2. BlueBubbles Server (USER + check)

If `/Applications/BlueBubbles.app` is missing, ask permission, then tell the user to download it from
https://bluebubbles.app/downloads/, move it to Applications and open it. In its setup the user must:
1. Grant **Full Disk Access**, **Accessibility** and **Automation → Messages** when prompted
   (System Settings → Privacy & Security).
2. Set a **server password** and keep the port at **1234**. Proxy service: **none / Dynamic DNS** (Tailscale is used instead).

**Check:** `lsof -nP -iTCP:1234 -sTCP:LISTEN >/dev/null && echo running`

## 3. Tailscale (USER + check)

The user installs Tailscale on the Mac (https://tailscale.com/download/mac) and iPhone (App Store) and signs in to both
with the same account, then enables **MagicDNS** and **HTTPS Certificates** at https://login.tailscale.com/admin/dns.

**Check:**
```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
"$TS" status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["BackendState"], d["Self"]["DNSName"], bool(d.get("CertDomains")))'
```
Must print `Running <name>.ts.net. True`.

## 4. Install the gateway

Interactive (the installer asks before reading the BlueBubbles password or installing uv):
```bash
curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash
```
If you cannot answer prompts, ask the user for consent first, then pass `--yes`:
```bash
curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash -s -- --yes
```
Options: `--with-whisper` (non-English dictation, +400 MB), `--port N` (default 8443).

**Check:** the output ends with `Gateway is up` and a **Gateway URL**. The token is put on the clipboard.

## 5. Verify end to end

```bash
"$HOME/Library/Application Support/BubblesG2/gateway/scripts/doctor.sh"
```
**Check:** `All checks passed.` For any `✗`, apply the printed fix and re-run. Re-running the installer is always safe.

## 6. Pair the glasses (USER)

Tell the user:
1. Make sure Tailscale is **on** on the iPhone.
2. In the Even App, open Even Hub → install **Bubbles for G2** → open it on the phone.
3. Enter the **Gateway URL** from step 4 and paste the **Gateway token** (on the clipboard; with Universal Clipboard it
   pastes on the iPhone. To copy it again:
   `( set -a; . "$HOME/Library/Application Support/BubblesG2/config/env"; printf %s "$G2_MSG_TOKEN" ) | pbcopy`).
4. Tap **Save & connect**. Expected status: `Gateway OK · Messages bridge up`.

## 7. Optional settings

- **Favorites:** set `G2_FAVORITES` in `~/Library/Application Support/BubblesG2/config/env` to comma-separated contact
  names exactly as in Contacts, single-quoted: `G2_FAVORITES='Jordan Lee,Casey Lee'`. Then re-run step 4.
- **Even AI ("Hey Even"), Even Hub developer accounts only:** Even App → Settings → Even AI → Agent Configuration:
  URL = Gateway URL + `/v1/chat/completions`; token = `G2_AGENT_TOKEN` (copy it with the step 6 command, swapping the
  variable name).

## Uninstall

```bash
"$HOME/Library/Application Support/BubblesG2/gateway/scripts/uninstall.sh"
```
