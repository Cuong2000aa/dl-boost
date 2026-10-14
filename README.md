# PulseDM v2

Extension Chrome/Edge kiểu **IDM**: tăng tốc đa kết nối, **pause/resume thật** (IndexedDB), lịch tải, grabber trang, hàng đợi ưu tiên, lịch sử, batch URL, bắt download trình duyệt.

## Tính năng

| Nhóm | Chi tiết |
|------|----------|
| Tăng tốc | HTTP Range, 1–16 kết nối, giới hạn tốc độ (KB/s) |
| Resume | Lưu từng segment vào IndexedDB — tạm dừng rồi tiếp tục không mất dữ liệu |
| Hàng đợi | Ưu tiên, đồng thời tối đa, bỏ qua/thay URL trùng |
| Lịch tải | Hẹn giờ từng file hoặc cả batch |
| Grabber | Panel phát hiện tệp, `Ctrl+Shift+Y`, `Alt+click` link |
| Bắt tải Chrome | Tuỳ chọn + lọc theo phần mở rộng / dung lượng tối thiểu |
| Manager | Tìm kiếm, phân loại, mở file / hiện thư mục, xuất JSON |
| Khác | Badge số tải đang chạy, thông báo, trang Options, phím tắt |

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
