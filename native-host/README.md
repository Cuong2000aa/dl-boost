# PulseDM Native Helper (macOS + Windows)

Giống hướng IDM: **extension + app nhỏ trên máy** (Chrome/Edge Native Messaging).

Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) để tải YouTube / Facebook / …

---

## Windows (không cần Python)

Helper đã đóng gói sẵn: `native-host/bin/pulsedm_host.exe` (x64) và `pulsedm_host-arm64.exe`.

1. Load unpacked PulseDM trong Edge → bật Developer mode → copy **ID**
2. Mở **PowerShell**:

```powershell
cd C:\path\to\dl-boost
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install-win.ps1 -ExtensionId YOUR_EXTENSION_ID
winget install yt-dlp.yt-dlp
```

3. Reload PulseDM → popup: `Helper: OK · yt-dlp …`

File tải: `%USERPROFILE%\Downloads\PulseDM`

### Build lại .exe (dev)

Trên Mac/Linux có Go:

```bash
chmod +x native-host/build-win.sh
./native-host/build-win.sh
```

### Gỡ (Windows)

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\PulseDM" -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.pulsedm.host" -Recurse -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.pulsedm.host" -Recurse -ErrorAction SilentlyContinue
```

---

## macOS

```bash
cd /path/to/dl-boost
chmod +x native-host/install-mac.sh
./native-host/install-mac.sh YOUR_EXTENSION_ID
brew install yt-dlp
```

Cần **Python 3** trên Mac (script `pulsedm_host.py`).

File tải: `~/Downloads/PulseDM`

### Gỡ (macOS)

- `~/.pulsedm/`
- `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.pulsedm.host.json`
- Chrome tương ứng nếu có

---

## Dùng

- Mở tab YT/FB → popup → **Tải tab (Helper)**  
- Hoặc dán URL trang vào ô URL  

## Giới hạn

- Cần cập nhật yt-dlp khi site đổi: `yt-dlp -U`  
- DRM / video private có thể fail  
- Tuân thủ ToS từng nền tảng  

## Kiểm tra host

```bash
# Mac (Python)
python3 native-host/pulsedm_host.py --status

# Windows (exe đã cài)
& "$env:LOCALAPPDATA\PulseDM\native-host\pulsedm_host.exe" --status
```
