#!/usr/bin/env bash
# Install PulseDM native host for Chrome + Edge on macOS.
# Usage:
#   ./native-host/install-mac.sh <EXTENSION_ID>
# Get EXTENSION_ID from edge://extensions → PulseDM → ID (Developer mode on)

set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <EXTENSION_ID>"
  echo "Mở edge://extensions → bật Developer mode → copy ID của PulseDM."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_SRC="$ROOT/pulsedm_host.py"
INSTALL_DIR="${HOME}/.pulsedm"
HOST_BIN="${INSTALL_DIR}/pulsedm_host.py"
JSON_NAME="com.pulsedm.host.json"

mkdir -p "$INSTALL_DIR"
cp "$HOST_SRC" "$HOST_BIN"
chmod +x "$HOST_BIN"

# Ensure shebang works with python3
if ! command -v python3 >/dev/null 2>&1; then
  echo "Cần python3. Cài: brew install python"
  exit 1
fi

TMP_JSON="$(mktemp)"
sed -e "s|__HOST_PATH__|${HOST_BIN}|g" -e "s|__EXTENSION_ID__|${EXT_ID}|g" \
  "$ROOT/com.pulsedm.host.json.template" > "$TMP_JSON"

register() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$TMP_JSON" "${dir}/${JSON_NAME}"
  echo "Registered: ${dir}/${JSON_NAME}"
}

# Chrome
register "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# Chrome Canary / Chromium (optional)
[[ -d "${HOME}/Library/Application Support/Google/Chrome Canary" ]] && \
  register "${HOME}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" || true
[[ -d "${HOME}/Library/Application Support/Chromium" ]] && \
  register "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts" || true

# Microsoft Edge
register "${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
[[ -d "${HOME}/Library/Application Support/Microsoft Edge Beta" ]] && \
  register "${HOME}/Library/Application Support/Microsoft Edge Beta/NativeMessagingHosts" || true

rm -f "$TMP_JSON"

echo ""
echo "✅ Native host installed."
echo "   Host: $HOST_BIN"
echo "   Ext : $EXT_ID"
echo ""
echo "Optional (YouTube/Facebook/…):"
echo "   brew install yt-dlp"
echo "   yt-dlp -U"
echo ""
echo "Reload PulseDM in edge://extensions then open popup → check Helper."

# Self-test
python3 "$HOST_BIN" --status || true
