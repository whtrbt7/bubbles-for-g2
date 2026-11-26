#!/bin/bash
# Bubbles for G2: install (or update) the gateway on this Mac. Safe to re-run.
#
#   ./install.sh [--yes] [--port 8443] [--with-whisper] [--models-from DIR] [--no-bluebubbles-autostart]
#
# Needs (see SETUP.md): Messages signed in, BlueBubbles Server running, Tailscale with HTTPS certificates enabled.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PORT=""
WITH_WHISPER=0
MODELS_FROM=""
BB_AUTOSTART=1
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --port) PORT="$2"; shift ;;
    --with-whisper) WITH_WHISPER=1 ;;
    --models-from) MODELS_FROM="$2"; shift ;;
    --no-bluebubbles-autostart) BB_AUTOSTART=0 ;;
    -h|--help) /usr/bin/sed -n '2,7p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done
export ASSUME_YES

step() { printf '\n%s== %s%s\n' "$C_DIM" "$*" "$C_OFF"; }

preflight() {
  step "Checking this Mac"
  [ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."
  ok "macOS $(sw_vers -productVersion) ($(uname -m))"
  [ -e "$HOME/Library/Messages" ] || warn "Messages has never been opened on this Mac. Sign in to Messages first."

  [ -d /Applications/BlueBubbles.app ] || { bad "BlueBubbles Server is not installed."; hint "Install it from https://bluebubbles.app/downloads/ and follow SETUP.md step 2."; exit 1; }
  if ! /usr/sbin/lsof -nP -iTCP:1234 -sTCP:LISTEN >/dev/null 2>&1; then
    bad "BlueBubbles Server is not running (nothing listening on port 1234)."
    hint "Open BlueBubbles, finish its setup, then re-run this installer."
    exit 1
  fi
  ok "BlueBubbles Server is running"

  TS="$(tailscale_cli)" || { bad "Tailscale is not installed."; hint "Install it from https://tailscale.com/download/mac and sign in."; exit 1; }
  [ "$(tailscale_field "$TS" state)" = "Running" ] || die "Tailscale is installed but not connected. Open Tailscale and sign in."
  HOST_NAME="$(tailscale_field "$TS" dns)"
  [ -n "$(tailscale_field "$TS" cert)" ] || { bad "HTTPS certificates are off for your tailnet."; hint "Turn on MagicDNS and HTTPS at https://login.tailscale.com/admin/dns, then re-run."; exit 1; }
  ok "Tailscale connected as $HOST_NAME"

  local free_gb
  free_gb="$(df -g "$HOME" | awk 'NR==2 {print $4}')"
  [ "${free_gb:-0}" -ge 2 ] || die "Need about 2 GB free disk space (have ${free_gb} GB)."
}

bluebubbles_password() {
  step "Connecting to BlueBubbles"
  local pw
  pw="$(env_get BB_PASSWORD || true)"
  if [ -n "$pw" ] && [ "$(bb_status "$BB_URL_DEFAULT" "$pw")" = "200" ]; then
    ok "Using the saved BlueBubbles password"
    return
  fi
  pw=""
  if [ -f "$BB_CONFIG_DB" ] && confirm "Read the BlueBubbles server password from its settings on this Mac?"; then
    pw="$(/usr/bin/sqlite3 "$BB_CONFIG_DB" "select value from config where name='password'" 2>/dev/null || true)"
  fi
  if [ -z "$pw" ]; then
    [ -t 0 ] || die "Cannot ask for the BlueBubbles password without a terminal. Re-run interactively or with --yes."
    read -r -s -p "BlueBubbles server password: " pw; echo
  fi
  [ "$(bb_status "$BB_URL_DEFAULT" "$pw")" = "200" ] || die "BlueBubbles rejected that password."
  env_set BB_PASSWORD "$pw"
  ok "BlueBubbles password verified and saved (readable only by you)"
}

install_code() {
  step "Installing the gateway"
  if ! command -v uv >/dev/null 2>&1; then
    confirm "Install uv (Python package manager from astral.sh, into ~/.local/bin)?" || die "uv is required."
    /usr/bin/curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    command -v uv >/dev/null 2>&1 || die "uv install failed."
  fi
  ok "uv $(uv --version | awk '{print $2}')"
  mkdir -p "$GATEWAY_DIR"
  if [ "$SOURCE_DIR" != "$GATEWAY_DIR" ]; then
    /usr/bin/rsync -a --delete --exclude .venv --exclude .pytest_cache --exclude __pycache__ --exclude tests \
      "$SOURCE_DIR/" "$GATEWAY_DIR/"
  fi
  (cd "$GATEWAY_DIR" && uv sync -q --no-dev --extra stt) || die "Installing Python packages failed."
  ok "Gateway installed in $GATEWAY_DIR"
}

fetch_model() {
  local name="$1"
  if [ -d "$MODELS_DIR/$name" ]; then ok "Model $name present"; return; fi
  mkdir -p "$MODELS_DIR"
  if [ -n "$MODELS_FROM" ] && [ -d "$MODELS_FROM/$name" ]; then
    /bin/cp -R "$MODELS_FROM/$name" "$MODELS_DIR/" && ok "Model $name copied from $MODELS_FROM"
    return
  fi
  say "Downloading $name (this can take a few minutes)..."
  /usr/bin/curl -fL --progress-bar -o "$MODELS_DIR/$name.tar.bz2" "$MODEL_BASE/$name.tar.bz2" || die "Download failed: $name"
  /usr/bin/tar -xjf "$MODELS_DIR/$name.tar.bz2" -C "$MODELS_DIR" && rm -f "$MODELS_DIR/$name.tar.bz2"
  # Whisper ships full-precision copies too; only the int8 files are used.
  rm -f "$MODELS_DIR/$name"/*-encoder.onnx "$MODELS_DIR/$name"/*-decoder.onnx
  ok "Model $name downloaded"
}

models() {
  step "Speech recognition models"
  fetch_model "$PARAKEET_MODEL"
  if [ "$WITH_WHISPER" = "1" ]; then fetch_model "$WHISPER_MODEL"; fi
}

configure() {
  step "Configuration"
  [ -n "$(env_get G2_MSG_TOKEN || true)" ] || env_set G2_MSG_TOKEN "$(random_token)"
  [ -n "$(env_get G2_AGENT_TOKEN || true)" ] || env_set G2_AGENT_TOKEN "$(random_token)"
  [ -n "$(env_get BB_URL || true)" ] || env_set BB_URL "$BB_URL_DEFAULT"
  if [ -n "$PORT" ]; then env_set G2_MSG_PORT "$PORT"; fi
  [ -n "$(env_get G2_MSG_PORT || true)" ] || env_set G2_MSG_PORT 8443
  [ -n "$(env_get G2_FAVORITES || true)" ] || env_set G2_FAVORITES ""
  ok "Settings in $ENV_FILE"
  hint "Edit G2_FAVORITES there (comma-separated contact names) and re-run install.sh to apply."
}

bluebubbles_autostart() {
  [ "$BB_AUTOSTART" = "1" ] || return 0
  step "Keep BlueBubbles running after restarts"
  if /usr/bin/osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | /usr/bin/grep -q BlueBubbles; then
    ok "BlueBubbles already opens at login"
  elif confirm "Add BlueBubbles to your login items?"; then
    if /usr/bin/osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/BlueBubbles.app", hidden:true}' >/dev/null; then
      ok "BlueBubbles added to login items"
    else
      warn "Could not add the login item; add BlueBubbles in System Settings > General > Login Items."
    fi
  fi
}

service() {
  step "Background service"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG_FILE")"
  /usr/bin/sed -e "s|__LABEL__|$BUBBLES_LABEL|g" -e "s|__RUN_SH__|$GATEWAY_DIR/scripts/run.sh|g" \
    -e "s|__BUBBLES_HOME__|$BUBBLES_HOME|g" -e "s|__LOG__|$LOG_FILE|g" \
    "$GATEWAY_DIR/scripts/gateway.plist.template" > "$PLIST"
  if launchd_loaded; then
    launchctl kickstart -k "gui/$(id -u)/$BUBBLES_LABEL"
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  ok "Service $BUBBLES_LABEL started (log: $LOG_FILE)"
}

wait_healthy() {
  step "Starting up"
  local port url body="" _
  port="$(env_get G2_MSG_PORT)"
  url="https://$HOST_NAME:$port"
  for _ in $(seq 1 45); do
    body="$(/usr/bin/curl -s --max-time 3 "$url/health" 2>/dev/null || true)"
    case "$body" in *'"bb":true'*) break ;; esac
    sleep 2
  done
  case "$body" in
    *'"bb":true'*) ok "Gateway is up: $body" ;;
    *) bad "Gateway did not become healthy. Last response: ${body:-none}"; hint "Run ./doctor.sh and check $LOG_FILE"; exit 1 ;;
  esac
  GATEWAY_URL="$url"
}

pairing() {
  step "Pair your glasses"
  say "In the Even App, open Bubbles for G2 and enter:"
  say "  Gateway URL:   $GATEWAY_URL"
  say "  Gateway token: (stored in $ENV_FILE as G2_MSG_TOKEN)"
  if env_get G2_MSG_TOKEN | /usr/bin/pbcopy 2>/dev/null; then
    ok "The token is on your clipboard; with Universal Clipboard you can paste it on your iPhone."
  fi
  say ""
  say "Optional, Even AI (\"Hey Even\") for Even Hub developer accounts:"
  say "  Agent URL:   $GATEWAY_URL/v1/chat/completions"
  say "  Agent token: G2_AGENT_TOKEN in $ENV_FILE"
}

preflight
bluebubbles_password
install_code
models
configure
bluebubbles_autostart
service
wait_healthy
pairing
