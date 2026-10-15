#!/usr/bin/env bash
# Cross-compile PulseDM native host for Windows (no Python on target).
# Run on Mac/Linux with Go installed, or with portable Go in ../.tools/go
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
# Go toolchain lives outside extension root (avoid Edge counting ~300MB)
export PATH="${REPO}/../.tools/go/bin:${REPO}/.tools/go/bin:${PATH:-}"
if ! command -v go >/dev/null 2>&1; then
  echo "Need Go. Install from https://go.dev/dl/ or place toolchain in ../.tools/go (sibling of extension folder)"
  exit 1
fi
mkdir -p "$ROOT/bin"
cd "$ROOT/go"
echo "Building Windows amd64…"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host.exe" .
echo "Building Windows arm64…"
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host-arm64.exe" .
echo "Building macOS arm64 + amd64…"
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host-darwin-arm64" .
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o "$ROOT/bin/pulsedm_host-darwin-amd64" .
ls -lh "$ROOT/bin/"pulsedm_host*
echo "OK → Win .exe + Mac darwin binaries"
