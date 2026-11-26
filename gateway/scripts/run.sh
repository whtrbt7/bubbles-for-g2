#!/bin/bash
# Started by launchd. Loads config, refreshes the Tailscale TLS certificate, serves HTTPS on the tailnet IP only.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE; run install.sh" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

TS="$(tailscale_cli)" || { echo "Tailscale CLI not found" >&2; exit 1; }
HOST_NAME="$(tailscale_field "$TS" dns)"
mkdir -p "$TLS_DIR" && chmod 700 "$TLS_DIR"
(cd "$TLS_DIR" && "$TS" cert --cert-file cert.pem --key-file key.pem "$HOST_NAME") \
  || echo "certificate refresh failed; using existing certificate" >&2

export G2_TLS_CERT="$TLS_DIR/cert.pem" G2_TLS_KEY="$TLS_DIR/key.pem"
G2_MSG_HOST="$("$TS" ip -4 | head -1)"
export G2_MSG_HOST
export G2_MSG_PORT="${G2_MSG_PORT:-8443}"
export G2_FAVORITES_FILE="${G2_FAVORITES_FILE:-$CONFIG_DIR/favorites.json}"
export STT_PARAKEET_DIR="${STT_PARAKEET_DIR:-$MODELS_DIR/$PARAKEET_MODEL}"
if [ -d "$MODELS_DIR/$WHISPER_MODEL" ]; then export STT_WHISPER_DIR="${STT_WHISPER_DIR:-$MODELS_DIR/$WHISPER_MODEL}"; fi

cd "$GATEWAY_DIR"
exec uv run --no-dev --extra stt python -m msg_gw
