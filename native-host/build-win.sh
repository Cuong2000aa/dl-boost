#!/usr/bin/env bash
# Cross-compile PulseDM native host for Windows (no Python on target).
# Run on Mac/Linux with Go installed, or with portable Go in ../.tools/go
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
export PATH="${REPO}/.tools/go/bin:${PATH:-}"
if ! command -v go >/dev/null 2>&1; then
  echo "Need Go. Install from https://go.dev/dl/ or place toolchain in .tools/go"
  exit 1
fi
mkdir -p "$ROOT/bin"
cd "$ROOT/go"
echo "Building Windows amd64…"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host.exe" .
echo "Building Windows arm64…"
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host-arm64.exe" .
ls -lh "$ROOT/bin/"pulsedm_host*.exe
echo "OK → native-host/bin/pulsedm_host.exe (x64) + pulsedm_host-arm64.exe"
