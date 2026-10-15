# PulseDM v2.5.1

Extension Edge/Chrome kiểu **IDM** + **Native Helper (Mac & Windows)**.

- **Intent Capture** — “Tải đang phát”  
- **Media Ledger (Kho)** — tìm file đã tải theo tên/URL/nguồn  
- Helper: Copy lệnh / tải script cài (ID sẵn)  
- Sniffer + auth tab, đa kết nối, offload file lớn, HLS→MP4  
- Network meter live + đo bandwidth  

Xem cài Helper: [`native-host/README.md`](native-host/README.md)

**Windows:** `.\native-host\install-win.ps1 -ExtensionId <ID>` rồi `winget install yt-dlp.yt-dlp Gyan.FFmpeg`  
**Mac:** `./native-host/install-mac.sh <ID>` rồi `brew install yt-dlp ffmpeg`

## Tính năng

| Nhóm | Chi tiết |
|------|----------|
| Native Helper | Go `.exe`/Mac binary + yt-dlp/ffmpeg → Downloads/PulseDM |
| Tăng tốc | HTTP Range 1–16, resume mid-part, rate limit |
| Auth sniff | Referer + cookie tab + DNR Referer |
| HLS | yt-dlp→MP4 ưu tiên; fallback TS + remux ffmpeg |
| Offload | File ≥ helperOffloadMinMB (mặc định 200MB) → Helper đĩa |
| Domain rules | Options: `host\|mode` (helper/accelerate/…) |
| Grabber | Network sniffer + `Cmd/Ctrl+Shift+Y` |
| Hàng đợi / lịch | Ưu tiên, batch, schedule |

## Cài đặt

1. Mở `chrome://extensions` hoặc `edge://extensions`
2. Bật **Developer mode**
3. **Load unpacked** → chọn thư mục gốc (có `manifest.json`)
4. Ghim **PulseDM**

Sau khi cập nhật code: bấm **Reload** trên card extension.

## Phím tắt

| Phím | Việc |
|------|------|
| `Alt+Shift+S` | Intent Capture — tải đang phát |
| `Alt+Shift+D` | Mở Manager |
| `Alt+Shift+A` | Mở tab Batch URL |
| `Ctrl+Shift+Y` (trên trang) | Mở grabber |
| `Ctrl+Shift+D` (trên trang) | Intent Capture nhanh |
| `Alt+click` link tệp | Thêm vào hàng đợi |

## Xem trước UI

```bash
python3 -m http.server 43127 --bind 127.0.0.1
```

Mở http://127.0.0.1:43127/preview/

## Cấu trúc

```
manifest.json                 # MV3
background/service-worker.js  # hàng đợi, lịch, capture, badge
lib/download-engine.js        # multi-connection + rate limit
lib/idb.js                    # segment store (resume)
lib/settings.js               # defaults
popup/  manager/  options/    # UI
content/                      # grabber + hotkeys
preview/                      # landing demo
```

## Giới hạn so với IDM native

Không hook toàn hệ thống Windows/macOS. Một số CDN chặn Range / cookie phức tạp → fallback 1 kết nối. Chrome quyết định thư mục Downloads (extension không ghi path tuỳ ý như IDM).

## Sao lưu

Options → **Xuất JSON** / **Nhập JSON** (jobs + history + settings).
