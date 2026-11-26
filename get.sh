#!/bin/bash
# Bubbles for G2 bootstrap: download the latest release and run the installer.
#
#   curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/whtrbt7/bubbles-for-g2/main/get.sh | bash -s -- --with-whisper
#
# Any arguments are passed to gateway/scripts/install.sh (see its --help).
set -euo pipefail
REPO="${BUBBLES_REPO:-whtrbt7/bubbles-for-g2}"
[ "$(uname -s)" = "Darwin" ] || { echo "Bubbles for G2 installs on macOS only." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TAG="${BUBBLES_VERSION:-$(/usr/bin/curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])')}"
echo "Downloading Bubbles for G2 $TAG..."
/usr/bin/curl -fsSL "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" | /usr/bin/tar -xz -C "$TMP"

INSTALLER="$(echo "$TMP"/*/gateway/scripts/install.sh)"
[ -f "$INSTALLER" ] || { echo "Installer not found in the download." >&2; exit 1; }

# When piped from curl, stdin is the script itself; give the installer the terminal for its questions.
if [ -t 1 ] && [ -r /dev/tty ]; then
  bash "$INSTALLER" "$@" < /dev/tty
else
  bash "$INSTALLER" "$@"
fi
