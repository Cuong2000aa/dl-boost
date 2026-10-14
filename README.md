# PulseDM

Extension Chrome/Edge kiểu **IDM**: quản lý tải xuống, tăng tốc nhiều kết nối (HTTP Range), hàng đợi, tạm dừng/tiếp tục, bắt link tệp trên trang.

## Tính năng (slice đầu)

- Thêm URL từ popup hoặc cửa sổ **Manager**
- Chuột phải → **Tải bằng PulseDM** (link / ảnh / video / audio)
- **Alt + click** liên kết tệp trên trang
- Sniffer nhẹ khi trang có file media/archive/pdf…
- Tăng tốc **đa kết nối** khi server hỗ trợ `Accept-Ranges`
- Hàng đợi, pause / resume / hủy, phân loại theo loại file
- Tuỳ chọn **bắt tải của trình duyệt** (tắt mặc định)

## Giới hạn so với IDM bản native

PulseDM chạy trong sandbox extension, không hook toàn hệ thống Windows như IDM. Resume sau pause tải lại từ đầu (chưa lưu segment ra đĩa). CORS / server không cho Range → tải 1 kết nối.

## Cài đặt

1. Mở `chrome://extensions` hoặc `edge://extensions`
2. Bật **Developer mode**
3. **Load unpacked** → chọn thư mục gốc repo này (chứa `manifest.json`)
4. Ghim icon **PulseDM**

## Dùng nhanh

1. Dán URL vào popup → **Tải**
2. Hoặc chuột phải link → **Tải bằng PulseDM**
3. Mở **Manager** để xem hàng đợi đầy đủ và chỉnh số kết nối (1–16)

## Xem trước UI (không cần load extension)

```bash
python3 -m http.server 43127 --bind 127.0.0.1
```

Mở [http://127.0.0.1:43127/preview/](http://127.0.0.1:43127/preview/)

## Cấu trúc

```
manifest.json
background/service-worker.js   # hàng đợi + bắt download
lib/download-engine.js         # probe + multi-connection
popup/                         # popup nhanh
manager/                       # cửa sổ quản lý
content/content.js             # Alt+click + sniffer
preview/                       # landing demo UI
```

## Quyền

`downloads`, `storage`, `contextMenus`, `notifications`, `tabs`, `host_permissions: <all_urls>` — cần để fetch Range và lưu file qua Chrome Downloads API.
