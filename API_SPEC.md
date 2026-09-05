# API Specification — AI Image Studio v1

| หัวข้อ | ค่า |
|---|---|
| Base URL (dev) | `http://127.0.0.1:7860` |
| Prefix | `/api/v1` |
| Auth | `Authorization: Bearer <access_token>` |
| Encoding | UTF-8 |
| อัปเดตล่าสุด | 2026-09-05 |

> Front-end อ่านค่า endpoint ทั้งหมดจาก `js/config.js` → `TAB_CONFIG[*].endpoint`
> ถ้าหลังบ้านเปลี่ยน path ต้องแก้ที่ไฟล์นั้นไฟล์เดียว

---

## 0. Conventions

### รูปแบบ Error (ทุก endpoint ใช้เหมือนกัน)

```json
{
  "error": {
    "code": "INVALID_FILE_TYPE",
    "message": "Only PNG, JPEG and WEBP are supported.",
    "field": "image"
  }
}
```

| HTTP | code | ความหมาย |
|---|---|---|
| 400 | `VALIDATION_ERROR` | ข้อมูลไม่ครบ/ผิดรูปแบบ |
| 400 | `INVALID_FILE_TYPE` | ไม่ใช่ PNG/JPG/WEBP |
| 401 | `UNAUTHORIZED` | ไม่มี token หรือ token หมดอายุ |
| 403 | `FORBIDDEN` | token ถูกต้องแต่ไม่มีสิทธิ์ |
| 404 | `NOT_FOUND` | ไม่พบทรัพยากร |
| 409 | `EMAIL_TAKEN` | อีเมลซ้ำ |
| 413 | `FILE_TOO_LARGE` | ไฟล์เกินลิมิต |
| 422 | `UNPROCESSABLE_IMAGE` | ไฟล์เสีย/ถอดรหัสไม่ได้ |
| 429 | `RATE_LIMITED` | ยิงถี่เกิน (มี `Retry-After` header) |
| 500 | `INTERNAL_ERROR` | ข้อผิดพลาดฝั่งเซิร์ฟเวอร์ |
| 503 | `MODEL_UNAVAILABLE` | โมเดลยังโหลดไม่เสร็จ |

### Header ที่ทุก response ต้องมี

```
X-Request-Id: 7f3a9c1e-...        ใช้ไล่ log
X-RateLimit-Remaining: 18
```

---

## 1. Health

### `GET /api/v1/health` — ไม่ต้องล็อกอิน

```bash
curl -s http://127.0.0.1:7860/api/v1/health
```

```json
{ "status": "ok", "version": "1.0.0", "models": { "sd": "loaded", "rembg": "loaded" }, "uptime_sec": 3821 }
```

---

## 2. Authentication

### 2.1 `POST /api/v1/auth/register`

| Field | Type | Rule |
|---|---|---|
| `name` | string | 2–50 ตัวอักษร |
| `email` | string | รูปแบบอีเมล, unique, lowercase |
| `password` | string | ≥ 8 ตัว, มีตัวอักษร + ตัวเลข |

```bash
curl -X POST http://127.0.0.1:7860/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Somchai","email":"som@example.com","password":"Passw0rd123"}'
```

**201 Created**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": { "id": "usr_01H...", "name": "Somchai", "email": "som@example.com", "created_at": "2026-09-05T09:12:00Z" }
}
```

**409** → `{"error":{"code":"EMAIL_TAKEN","message":"...","field":"email"}}`

---

### 2.2 `POST /api/v1/auth/login`

```bash
curl -X POST http://127.0.0.1:7860/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"som@example.com","password":"Passw0rd123"}'
```

**200** → โครงสร้างเดียวกับ register
**401** → `INVALID_CREDENTIALS` (ห้ามบอกว่า "อีเมลไม่มี" หรือ "รหัสผิด" แยกกัน — บอกรวมว่า "อีเมลหรือรหัสผ่านไม่ถูกต้อง")

---

### 2.3 `GET /api/v1/auth/me`

```bash
curl http://127.0.0.1:7860/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "user": { "id": "usr_01H...", "name": "Somchai", "email": "som@example.com" } }
```

---

### 2.4 `POST /api/v1/auth/logout`

```bash
curl -X POST http://127.0.0.1:7860/api/v1/auth/logout -H "Authorization: Bearer $TOKEN"
```

**204 No Content** — เพิ่ม token เข้า denylist จนกว่าจะหมดอายุ

---

## 3. User Data

### 3.1 `GET|PUT /api/v1/notes` — โน้ตส่วนตัว

```bash
# อ่าน
curl http://127.0.0.1:7860/api/v1/notes -H "Authorization: Bearer $TOKEN"

# เขียน (max 20,000 ตัวอักษร)
curl -X PUT http://127.0.0.1:7860/api/v1/notes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"prompt ที่ชอบ: cinematic lighting, 85mm"}'
```

```json
{ "content": "prompt ที่ชอบ: ...", "updated_at": "2026-09-05T10:04:11Z" }
```

---

### 3.2 `GET|PUT /api/v1/preferences` — ภาษา + การตั้งค่าแท็บ

```bash
curl -X PUT http://127.0.0.1:7860/api/v1/preferences \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "lang": "th",
        "tabs": [
          {"id":"genimage","on":true},
          {"id":"back","on":true},
          {"id":"icon","on":false},
          {"id":"tone","on":true}
        ]
      }'
```

> `tabs` ต้องมี `on: true` อย่างน้อย 1 รายการ ไม่งั้นตอบ 400 `VALIDATION_ERROR`
> `id` ที่ไม่รู้จักให้เซิร์ฟเวอร์ตัดทิ้งเงียบ ๆ (forward-compatible)

---

## 4. Image Endpoints

ทุก endpoint ในหมวดนี้ **ต้องมี token** และตอบกลับเป็น **binary image stream** (ไม่ใช่ JSON)

| Response header | ตัวอย่าง |
|---|---|
| `Content-Type` | `image/png` |
| `Content-Disposition` | `inline; filename="result.png"` |
| `X-Process-Time-Ms` | `4821` |
| `X-Seed` | `918273645` *(เฉพาะ generate)* |

---

### 4.1 `POST /api/v1/generate` — text2img

`Content-Type: application/json`

| Field | Type | Default | Rule |
|---|---|---|---|
| `prompt` | string | — | **required**, 1–2000 ตัว |
| `negative_prompt` | string | `""` | ≤ 2000 ตัว |
| `width` | int | 1024 | 512–1536, หารด้วย 64 ลงตัว |
| `height` | int | 1024 | 512–1536, หารด้วย 64 ลงตัว |
| `steps` | int | 30 | 10–50 |
| `seed` | int | random | -1 = สุ่ม |

```bash
curl -X POST http://127.0.0.1:7860/api/v1/generate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"a blue chrysanthemum, macro, soft light","negative_prompt":"blurry, watermark","width":1024,"height":1024,"steps":30}' \
  --output out.png
```

---

### 4.2 `POST /api/v1/remove-background`

`Content-Type: multipart/form-data` · ไฟล์สูงสุด **12 MB**

| Field | Type | Values | Default |
|---|---|---|---|
| `image` | file | PNG / JPEG / WEBP | **required** |
| `output` | string | `transparent` \| `white` \| `black` | `transparent` |
| `refine_edge` | bool | `true` \| `false` | `true` |

```bash
curl -X POST http://127.0.0.1:7860/api/v1/remove-background \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@IMG_20251212_115653.jpg" \
  -F "output=transparent" -F "refine_edge=true" \
  --output cutout.png
```

---

### 4.3 `POST /api/v1/clean-image` — ลบลายน้ำ & นอยส์

ไฟล์สูงสุด **12 MB**

| Field | Values | Default |
|---|---|---|
| `image` | file | **required** |
| `denoise` | `low` \| `medium` \| `high` | `medium` |
| `remove_watermark` | bool | `true` |

```bash
curl -X POST http://127.0.0.1:7860/api/v1/clean-image \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@noisy.png" -F "denoise=medium" -F "remove_watermark=true" \
  --output clean.png
```

---

### 4.4 `POST /api/v1/color-grade` — ปรับโทนสี

ไฟล์สูงสุด **20 MB** · คืนค่าเป็น `image/jpeg`

| Field | Values | Default |
|---|---|---|
| `image` | file | **required** |
| `tone` | `warm` \| `cool` \| `pastel` \| `mono` \| `vivid` \| `cinematic` | `warm` |
| `strength` | int 0–100 | `70` |

```bash
curl -X POST http://127.0.0.1:7860/api/v1/color-grade \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@IMG_20251212_115653.jpg" \
  -F "tone=warm" -F "strength=70" \
  --output graded.jpg
```

---

## 5. Rate Limits

| กลุ่ม | ลิมิต | ขอบเขต |
|---|---|---|
| `/auth/login`, `/auth/register` | 5 ครั้ง / 15 นาที | ต่อ IP |
| Image endpoints | 20 ครั้ง / ชั่วโมง | ต่อ user |
| อื่น ๆ | 120 ครั้ง / นาที | ต่อ user |

เกินลิมิต → `429` + `Retry-After: 300`

---

## 6. CORS

```
Access-Control-Allow-Origin: http://127.0.0.1:5500     # dev เท่านั้น ห้ามใช้ *
Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 600
```

Production ต้องเปลี่ยนเป็นโดเมนจริงเท่านั้น

---

## 7. Security Checklist (หลังบ้านต้องทำครบ)

- [ ] แฮชรหัสผ่านด้วย **argon2id** หรือ **bcrypt cost ≥ 12** — ห้าม MD5 / SHA1 / SHA256 เปล่า
- [ ] JWT: อายุ ≤ 24 ชม. · secret ≥ 32 ไบต์จาก env · ตรวจ `alg` ไม่ให้เป็น `none`
- [ ] ตรวจชนิดไฟล์จาก **magic bytes** ไม่ใช่แค่ `Content-Type` หรือนามสกุล
- [ ] จำกัดขนาด **ก่อน** อ่านเข้าหน่วยความจำ (streaming + `MAX_CONTENT_LENGTH`)
- [ ] ป้องกัน decompression bomb — ตรวจ `width × height` ก่อน decode (เพดาน 50 MP)
- [ ] ลบ EXIF ทั้งหมดในไฟล์ผลลัพธ์ (มี GPS ผู้ใช้ติดไปด้วย)
- [ ] ตั้งชื่อไฟล์ใหม่ด้วย UUID — ห้ามใช้ชื่อจากผู้ใช้ (path traversal)
- [ ] ข้อความ error ตอนล็อกอินต้องคลุมเครือเสมอ ไม่บอกว่าอีเมลมีอยู่จริงหรือไม่ (user enumeration)
- [ ] Rate limit ที่ระดับ reverse proxy ด้วย ไม่ใช่แค่ใน app
- [ ] Production บังคับ HTTPS + `Strict-Transport-Security`
- [ ] Log ห้ามบันทึกรหัสผ่าน / token / prompt ของผู้ใช้

---

## 8. Changelog

| Version | วันที่ | รายการ |
|---|---|---|
| 1.0.0 | 2026-09-05 | ฉบับแรก — auth, notes, preferences, image 4 endpoints |