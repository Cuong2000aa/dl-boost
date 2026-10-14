# Install PulseDM native host for Chrome + Edge on Windows.
# Uses prebuilt pulsedm_host.exe — KHÔNG cần cài Python.
#
# Usage (PowerShell):
#   cd path\to\dl-boost
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\native-host\install-win.ps1 -ExtensionId YOUR_EXTENSION_ID
#
# Get Extension ID: edge://extensions → Developer mode → PulseDM → ID

param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "PulseDM\native-host"
$HostJson = Join-Path $InstallDir "com.pulsedm.host.json"

# Pick exe by CPU (ARM64 Windows vs x64)
$IsArm = $env:PROCESSOR_ARCHITECTURE -match "ARM64"
$SrcExeName = if ($IsArm) { "pulsedm_host-arm64.exe" } else { "pulsedm_host.exe" }
$SrcExe = Join-Path $Root "bin\$SrcExeName"
if (-not (Test-Path $SrcExe)) {
  # Fallback: other arch / legacy name
  $alt = Join-Path $Root "bin\pulsedm_host.exe"
  if (Test-Path $alt) { $SrcExe = $alt; $SrcExeName = "pulsedm_host.exe" }
}

if (-not (Test-Path $SrcExe)) {
  Write-Host "ERROR: Không thấy $SrcExeName trong native-host\bin\"
  Write-Host "Trên máy có Go: chạy native-host\build-win.sh (hoặc build trên Mac rồi copy bin\)."
  exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$HostExe = Join-Path $InstallDir "pulsedm_host.exe"
Copy-Item -Force $SrcExe $HostExe

# Native Messaging path = .exe (no Python / no .bat)
$exePath = $HostExe.Replace("\", "\\")
$json = @"
{
  "name": "com.pulsedm.host",
  "description": "PulseDM native download helper",
  "path": "$exePath",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@
Set-Content -Path $HostJson -Value $json -Encoding UTF8

function Register-NativeHost([string]$RegPath) {
  New-Item -Path $RegPath -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name "(default)" -Value $HostJson -PropertyType String -Force | Out-Null
  Write-Host "Registered: $RegPath"
}

Register-NativeHost "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.pulsedm.host"
Register-NativeHost "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pulsedm.host"

Write-Host ""
Write-Host "OK Native host installed (standalone .exe — không cần Python)."
Write-Host "  Host : $HostExe"
Write-Host "  JSON : $HostJson"
Write-Host "  Ext  : $ExtensionId"
Write-Host "  Arch : $SrcExeName"
Write-Host ""
Write-Host "Cài yt-dlp (để tải YouTube/Facebook):"
Write-Host "  winget install yt-dlp.yt-dlp"
Write-Host ""
Write-Host "Reload PulseDM trong edge://extensions, rồi mở popup → Helper status."

try {
  & $HostExe --status
} catch {
  Write-Host "Self-test skipped: $_"
}
