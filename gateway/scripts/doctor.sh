#!/bin/bash
# Bubbles for G2: check every link from Messages to the glasses and say what to fix. Never prints secrets.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

FAILS=0
fail() { bad "$1"; shift; for h in "$@"; do hint "$h"; done; FAILS=$((FAILS + 1)); }

say "Bubbles for G2 doctor  ($(sw_vers -productVersion), $(uname -m))"

# 1. Messages + BlueBubbles
if [ -e "$HOME/Library/Messages" ]; then ok "Messages has been set up on this Mac"; else fail "Messages not set up" "Open Messages and sign in with the same Apple Account as your iPhone."; fi
if [ -d /Applications/BlueBubbles.app ]; then ok "BlueBubbles Server installed"; else fail "BlueBubbles Server not installed" "See SETUP.md step 2."; fi
if /usr/sbin/lsof -nP -iTCP:1234 -sTCP:LISTEN >/dev/null 2>&1; then ok "BlueBubbles Server running on port 1234"; else fail "BlueBubbles Server not running" "Open BlueBubbles. Add it to Login Items so it survives restarts."; fi

BB_PW="$(env_get BB_PASSWORD 2>/dev/null || true)"
if [ -z "$BB_PW" ]; then
  fail "No BlueBubbles password saved" "Run ./install.sh."
else
  case "$(bb_status "$(env_get BB_URL || echo "$BB_URL_DEFAULT")" "$BB_PW")" in
    200) ok "BlueBubbles accepts the saved password" ;;
    401) fail "BlueBubbles rejected the saved password" "The server password changed. Re-run ./install.sh." ;;
    *) fail "BlueBubbles API not answering" "Restart BlueBubbles." ;;
  esac
fi

# 2. Tailscale
if TS="$(tailscale_cli)"; then
  STATE="$(tailscale_field "$TS" state)"
  HOST_NAME="$(tailscale_field "$TS" dns)"
  if [ "$STATE" = "Running" ]; then ok "Tailscale connected as $HOST_NAME"; else fail "Tailscale not connected ($STATE)" "Open Tailscale and sign in."; fi
  if [ -n "$(tailscale_field "$TS" cert)" ]; then ok "Tailscale HTTPS certificates enabled"; else fail "Tailscale HTTPS certificates disabled" "Enable MagicDNS + HTTPS at https://login.tailscale.com/admin/dns"; fi
else
  HOST_NAME=""
  fail "Tailscale not installed" "https://tailscale.com/download/mac"
fi

# 3. Gateway service
if [ -f "$ENV_FILE" ]; then ok "Config present ($(stat -f %Lp "$ENV_FILE") permissions)"; else fail "No config at $ENV_FILE" "Run ./install.sh."; fi
if launchd_loaded; then ok "Service $BUBBLES_LABEL loaded"; else fail "Service $BUBBLES_LABEL not loaded" "Run ./install.sh."; fi
if [ -d "$MODELS_DIR/$PARAKEET_MODEL" ]; then ok "Parakeet speech model present"; else fail "Speech model missing" "Run ./install.sh."; fi

CERT="$TLS_DIR/cert.pem"
if [ -f "$CERT" ]; then
  if /usr/bin/openssl x509 -checkend $((14 * 86400)) -noout -in "$CERT" >/dev/null 2>&1; then
    ok "TLS certificate valid for 14+ days"
  else
    fail "TLS certificate expires within 14 days" "Restart the service: launchctl kickstart -k gui/$(id -u)/$BUBBLES_LABEL"
  fi
else
  fail "No TLS certificate yet" "The service creates it on start; check $LOG_FILE"
fi

PORT="$(env_get G2_MSG_PORT 2>/dev/null || echo 8443)"
if [ -n "$HOST_NAME" ]; then
  URL="https://$HOST_NAME:${PORT:-8443}"
  BODY="$(/usr/bin/curl -s --max-time 5 "$URL/health" 2>/dev/null || true)"
  case "$BODY" in
    *'"bb":true'*) ok "Gateway healthy at $URL" ;;
    *'"ok":true'*) fail "Gateway up but cannot reach BlueBubbles" "Check BlueBubbles is running and the password is current." ;;
    *) fail "Gateway not answering at $URL" "See $LOG_FILE (last lines below)."; [ -f "$LOG_FILE" ] && tail -n 5 "$LOG_FILE" | /usr/bin/sed -E 's/password=[^& "]*/password=REDACTED/g' | /usr/bin/sed 's/^/    /' ;;
  esac
  case "$BODY" in *parakeet*) ok "Dictation engine loaded" ;; *'"stt":[]'*) fail "No dictation engine loaded" "Re-run ./install.sh to restore the model." ;; esac

  # 4. Real data through the gateway (counts only)
  TOKEN="$(env_get G2_MSG_TOKEN 2>/dev/null || true)"
  if [ -n "$TOKEN" ]; then
    CHATS="$(/usr/bin/curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$URL/chats?limit=25" 2>/dev/null || true)"
    COUNT="$(printf '%s' "$CHATS" | /usr/bin/python3 -c 'import json,sys
try: print(len(json.load(sys.stdin)))
except Exception: print(-1)' 2>/dev/null)"
    if [ "${COUNT:--1}" -ge 0 ] 2>/dev/null; then ok "Gateway can read conversations ($COUNT recent)"; else fail "Gateway could not list conversations" "Check $LOG_FILE"; fi
    SMS="$(printf '%s' "$CHATS" | /usr/bin/grep -c '"guid":"SMS;' || true)"
    if [ "${SMS:-0}" = "0" ]; then
      warn "No SMS (green bubble) chats among recent conversations"
      hint "If you text Android users: iPhone > Settings > Apps > Messages > Text Message Forwarding > enable this Mac."
    fi
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then ok "All checks passed."; else bad "$FAILS problem(s) found."; fi
exit "$FAILS"
