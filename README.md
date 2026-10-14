# PulseDM v2.3.2

Extension Edge/Chrome kiểu **IDM** + **Native Helper (Mac & Windows)**.

- Trong browser: bắt media, HLS, đa kết nối, resume, grabber  
- Ngoài browser: Helper gọi **yt-dlp** để tải YouTube/Facebook/…

Xem cài Helper: [`native-host/README.md`](native-host/README.md)

**Windows:** `.\native-host\install-win.ps1 -ExtensionId <ID>` (đã có `.exe`, **không cần Python**) rồi `winget install yt-dlp.yt-dlp`  
**Mac:** `./native-host/install-mac.sh <ID>` rồi `brew install yt-dlp`

## Tính năng

| Nhóm | Chi tiết |
|------|----------|
| Native Helper | App nhỏ Mac/Win + `yt-dlp` (YT/FB/…) → Downloads/PulseDM |
| Tăng tốc | HTTP Range, 1–16 kết nối, giới hạn tốc độ (KB/s) |
| Resume | Segment IndexedDB + offscreen save |
| Grabber | Network sniffer + `Cmd/Ctrl+Shift+Y` |
| Hàng đợi / lịch | Ưu tiên, batch, schedule |
| Manager | Tìm kiếm, phân loại, options, xuất JSON |

## Cài đặt

1. Mở `chrome://extensions` hoặc `edge://extensions`
2. Bật **Developer mode**
3. **Load unpacked** → chọn thư mục gốc (có `manifest.json`)
4. Ghim **PulseDM**

Sau khi cập nhật code: bấm **Reload** trên card extension.

## Phím tắt

| Phím | Việc |
|------|------|
| `Alt+Shift+D` | Mở Manager |
| `Alt+Shift+A` | Mở tab Batch URL |
| `Ctrl+Shift+Y` (trên trang web) | Mở grabber |
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
