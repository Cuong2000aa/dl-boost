/**
 * Native Helper install helpers for popup / options.
 */

export function isWindowsUa(ua = navigator.userAgent) {
  return /Windows/i.test(ua || "");
}

export function buildInstallCommands(extensionId, { repoHint = "" } = {}) {
  const id = extensionId || "YOUR_EXTENSION_ID";
  const repo = repoHint || "PATH/TO/dl-boost";
  if (isWindowsUa()) {
    return [
      `cd ${repo.replace(/\//g, "\\")}`,
      "Set-ExecutionPolicy -Scope Process Bypass",
      `.\\native-host\\install-win.ps1 -ExtensionId ${id}`,
      "winget install yt-dlp.yt-dlp",
      "winget install Gyan.FFmpeg",
    ].join("\n");
  }
  return [
    `cd ${repo}`,
    "chmod +x native-host/install-mac.sh",
    `./native-host/install-mac.sh ${id}`,
    "brew install yt-dlp ffmpeg",
  ].join("\n");
}

/** Script user saves into native-host/ then runs (ID baked in). */
export function buildInstallScriptFile(extensionId) {
  const id = extensionId || "YOUR_EXTENSION_ID";
  if (isWindowsUa()) {
    return {
      filename: "cai-pulsedm.ps1",
      mime: "text/plain",
      body: [
        "# PulseDM Helper — đặt file này trong thư mục native-host rồi chạy:",
        "#   powershell -ExecutionPolicy Bypass -File .\\cai-pulsedm.ps1",
        `$ErrorActionPreference = "Stop"`,
        `$Root = Split-Path -Parent $MyInvocation.MyCommand.Path`,
        `Set-Location $Root`,
        `& "$Root\\install-win.ps1" -ExtensionId "${id}"`,
        `Write-Host "Xong. Reload PulseDM trong edge://extensions"`,
      ].join("\r\n"),
    };
  }
  return {
    filename: "cai-pulsedm.command",
    mime: "text/x-shellscript",
    body: [
      "#!/bin/bash",
      "# PulseDM Helper — lưu vào thư mục native-host, rồi double-click.",
      "set -euo pipefail",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      `chmod +x "$DIR/install-mac.sh"`,
      `"$DIR/install-mac.sh" "${id}"`,
      'echo ""',
      'echo "Xong. Reload PulseDM trong edge://extensions rồi mở lại popup."',
      'read -r -p "Enter để đóng…"',
    ].join("\n"),
  };
}

export function downloadTextFile({ filename, body, mime = "text/plain" }) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
