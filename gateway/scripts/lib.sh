#!/bin/bash
# Shared helpers for install.sh / doctor.sh / uninstall.sh. Compatible with macOS's bash 3.2.
# shellcheck disable=SC2034  # variables here are used by the scripts that source this file

BUBBLES_HOME="${BUBBLES_HOME:-$HOME/Library/Application Support/BubblesG2}"
BUBBLES_LABEL="${BUBBLES_LABEL:-com.bubblesg2.gateway}"
CONFIG_DIR="$BUBBLES_HOME/config"
ENV_FILE="$CONFIG_DIR/env"
TLS_DIR="$CONFIG_DIR/tls"
GATEWAY_DIR="$BUBBLES_HOME/gateway"
MODELS_DIR="$BUBBLES_HOME/models"
PLIST="$HOME/Library/LaunchAgents/$BUBBLES_LABEL.plist"
LOG_FILE="$HOME/Library/Logs/BubblesG2${BUBBLES_LOG_SUFFIX:-}.log"
BB_CONFIG_DB="$HOME/Library/Application Support/bluebubbles-server/config.db"
BB_URL_DEFAULT="http://127.0.0.1:1234"
MODEL_BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
PARAKEET_MODEL="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
WHISPER_MODEL="sherpa-onnx-whisper-small"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_WARN=""; C_DIM=""; C_OFF=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
bad()  { printf '%s✗%s %s\n' "$C_BAD" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
hint() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
die()  { bad "$*"; exit 1; }

# Ask a yes/no question; honours ASSUME_YES=1. Default answer is "no".
confirm() {
  if [ "${ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  local reply
  read -r -p "$1 [y/N] " reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Print the path of a working Tailscale CLI, or nothing.
tailscale_cli() {
  local c
  for c in "$(command -v tailscale 2>/dev/null)" \
           /Applications/Tailscale.app/Contents/MacOS/Tailscale \
           /usr/local/bin/tailscale /opt/homebrew/bin/tailscale; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" version >/dev/null 2>&1; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

# Read one key from `tailscale status --json` (Self.DNSName, CertDomains[0], BackendState).
tailscale_field() {
  "$1" status --json 2>/dev/null | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
key = sys.argv[1]
if key == "dns":
    print((d.get("Self") or {}).get("DNSName", "").rstrip("."))
elif key == "cert":
    print((d.get("CertDomains") or [""])[0])
elif key == "state":
    print(d.get("BackendState", ""))
' "$2" 2>/dev/null
}

# Values are stored single-quoted (with ' escaped as '\'') so the file is safe to `source`
# even if a password contains $, ", ` or spaces.
_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | /usr/bin/sed "s/'/'\\\\''/g")"
}

# Read KEY from the env file without sourcing it.
env_get() {
  [ -f "$ENV_FILE" ] || return 1
  # shellcheck disable=SC1090
  (set -a; . "$ENV_FILE" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"")
}

# Set KEY=VALUE in the env file (creating it with mode 600), replacing an existing line.
env_set() {
  local key="$1" value="$2" tmp
  mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
  touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
  tmp="$(mktemp)"
  /usr/bin/grep -v "^$key=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$(_shell_quote "$value")" >> "$tmp"
  cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
}

random_token() {
  /usr/bin/python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
}

# HTTP status of a BlueBubbles API call with the given password (password goes in the query, never printed).
bb_status() {
  /usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 5 -G \
    --data-urlencode "password=$2" "$1/api/v1/server/info" 2>/dev/null || printf '000'
}

launchd_loaded() {
  launchctl print "gui/$(id -u)/$BUBBLES_LABEL" >/dev/null 2>&1
}
