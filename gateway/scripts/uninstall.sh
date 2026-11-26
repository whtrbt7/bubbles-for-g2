#!/bin/bash
# Bubbles for G2: stop and remove the gateway. Leaves BlueBubbles, Tailscale and Messages untouched.
#   ./uninstall.sh [--yes] [--keep-config]
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ASSUME_YES=0
KEEP_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --keep-config) KEEP_CONFIG=1 ;;
    *) die "Unknown option: $arg" ;;
  esac
done
export ASSUME_YES

confirm "Remove the Bubbles for G2 gateway from this Mac?" || { say "Nothing removed."; exit 0; }

if launchd_loaded; then
  launchctl bootout "gui/$(id -u)/$BUBBLES_LABEL" 2>/dev/null && ok "Stopped service $BUBBLES_LABEL"
fi
[ -f "$PLIST" ] && rm -f "$PLIST" && ok "Removed $PLIST"

if [ -d "$BUBBLES_HOME" ]; then
  if [ "$KEEP_CONFIG" = "1" ]; then
    rm -rf "$GATEWAY_DIR" "$MODELS_DIR" && ok "Removed gateway and models (kept $CONFIG_DIR)"
  else
    rm -rf "$BUBBLES_HOME" && ok "Removed $BUBBLES_HOME (code, models, tokens, certificate)"
  fi
fi
[ -f "$LOG_FILE" ] && rm -f "$LOG_FILE" && ok "Removed $LOG_FILE"
say "Done. BlueBubbles Server and Tailscale were left installed; remove them separately if you no longer need them."
