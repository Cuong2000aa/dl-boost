#!/usr/bin/env bash
# Install PulseDM native host for Chrome + Edge on macOS (Go binary — no Python required).
# Usage:
#   ./native-host/install-mac.sh <EXTENSION_ID>

set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <EXTENSION_ID>"
  echo "Mở edge://extensions → bật Developer mode → copy ID của PulseDM."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${HOME}/.pulsedm"
JSON_NAME="com.pulsedm.host.json"
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  SRC_BIN="$ROOT/bin/pulsedm_host-darwin-arm64"
else
  SRC_BIN="$ROOT/bin/pulsedm_host-darwin-amd64"
fi

# Fallback: build on the fly if Go available and binary missing
if [[ ! -f "$SRC_BIN" ]]; then
  if command -v go >/dev/null 2>&1 || [[ -x "$ROOT/../../.tools/go/bin/go" ]] || [[ -x "$ROOT/../.tools/go/bin/go" ]]; then
    echo "Building macOS host…"
    export PATH="${ROOT}/../../.tools/go/bin:${ROOT}/../.tools/go/bin:${PATH:-}"
    mkdir -p "$ROOT/bin"
    (cd "$ROOT/go" && CGO_ENABLED=0 go build -ldflags="-s -w" -o "$SRC_BIN" .)
  fi
fi

# Legacy Python fallback
if [[ ! -f "$SRC_BIN" ]]; then
  echo "WARN: không thấy $SRC_BIN — fallback pulsedm_host.py (cần python3)"
  HOST_BIN="${INSTALL_DIR}/pulsedm_host.py"
  mkdir -p "$INSTALL_DIR"
  cp "$ROOT/pulsedm_host.py" "$HOST_BIN"
  chmod +x "$HOST_BIN"
else
  HOST_BIN="${INSTALL_DIR}/pulsedm_host"
  mkdir -p "$INSTALL_DIR"
  cp "$SRC_BIN" "$HOST_BIN"
  chmod +x "$HOST_BIN"
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

register "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
[[ -d "${HOME}/Library/Application Support/Google/Chrome Canary" ]] && \
  register "${HOME}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" || true
[[ -d "${HOME}/Library/Application Support/Chromium" ]] && \
  register "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts" || true
register "${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
[[ -d "${HOME}/Library/Application Support/Microsoft Edge Beta" ]] && \
  register "${HOME}/Library/Application Support/Microsoft Edge Beta/NativeMessagingHosts" || true

rm -f "$TMP_JSON"

echo ""
echo "OK Native host installed (Mac Go binary)."
echo "  Host: $HOST_BIN"
echo "  Ext : $EXT_ID"
echo ""
echo "Optional: brew install yt-dlp ffmpeg"
echo "Reload PulseDM rồi mở popup → Helper."

"$HOST_BIN" --status 2>/dev/null || python3 "$HOST_BIN" --status 2>/dev/null || true
