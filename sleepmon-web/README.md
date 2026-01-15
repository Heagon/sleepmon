# SleepMon bundle (API + Web)

## 1) API (Cloudflare Worker)
Thư mục: `api/`

### B1. Cài wrangler
- Node.js + npm
- `npm i -g wrangler`

### B2. Tạo D1 + R2
- D1: tạo DB `sleepmon_db`, lấy `database_id` rồi điền vào `api/wrangler.toml`
- R2: tạo bucket `sleepmon-abnormal`

### B3. Set token
- `wrangler secret put AUTH_TOKEN` (nhập đúng token ESP32 đang dùng)

### B4. Deploy
- `cd api`
- `wrangler deploy`

Sau khi deploy, bạn sẽ có domain dạng: `https://sleepmon-api.<your>.workers.dev`

Test nhanh:
- `GET /health`  -> `{ ok:true }`

## 2) Web (Cloudflare Pages)
Các file web nằm ở **root**: `index.html`, `style.css`, `app.js`

### B1. Sửa API_BASE
Trong `app.js`, sửa:
```js
const API_BASE = "https://sleepmon-api.sleepmon.workers.dev";
```
thành đúng domain Worker của bạn.

### B2. Deploy Pages
- Direct upload (kéo thả) hoặc GitHub Pages build output là root.
- Mở web, nếu API read có yêu cầu auth thì dán Bearer token vào ô **Bearer token** và bấm **Lưu token**.

## 3) Abnormal audio
ESP32 upload file `.sma` (SMA1 = IMA-ADPCM). Web sẽ:
- Tải file gốc từ `/abnormal/get?key=...`
- Giải mã SMA1 -> PCM16 -> WAV
- Play trực tiếp + tải `.wav`

## 4) Lưu ý
- Mặc định Worker cho phép GET public, POST yêu cầu token.
- Nếu bạn muốn GET cũng yêu cầu token: mở `api/worker.js` và set `READ_PUBLIC = false`, deploy lại.
