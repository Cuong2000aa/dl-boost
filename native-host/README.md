# PulseDM Native Helper (macOS + Windows)

Go binary — **không cần Python**. Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/).

---

## Windows

```powershell
cd C:\path\to\dl-boost
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install-win.ps1 -ExtensionId YOUR_EXTENSION_ID
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

File: `%USERPROFILE%\Downloads\PulseDM`

---

## macOS

```bash
cd /path/to/dl-boost
chmod +x native-host/install-mac.sh
./native-host/install-mac.sh YOUR_EXTENSION_ID
brew install yt-dlp ffmpeg
```

Dùng `native-host/bin/pulsedm_host-darwin-arm64` (Apple Silicon) hoặc `…-amd64`.

File: `~/Downloads/PulseDM`

---

## Build lại

```bash
./native-host/build-win.sh   # Win + Mac binaries → native-host/bin/
```

---

## Khả năng host

- Multi-connection HTTP ghi đĩa + Referer/Cookie  
- yt-dlp (YT/FB/HLS → mp4)  
- `open-path` / `reveal-path`  
- `remux` (.ts → .mp4 qua ffmpeg)  
- `cancel` job  

```bash
./native-host/bin/pulsedm_host-darwin-arm64 --status
# Win:
%LOCALAPPDATA%\PulseDM\native-host\pulsedm_host.exe --status

# CLI download (progress → stderr, JSON → stdout)
./scripts/pulsedm download -o ~/Downloads/PulseDM "https://example.com/file.zip"
./scripts/pulsedm download -e ytdlp "https://youtu.be/…"
```
