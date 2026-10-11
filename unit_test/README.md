# unit_test

ทดสอบการเชื่อมต่อ frontend ↔ backend โดยไม่ต้องเปิดเครื่องอื่น

```
เบราว์เซอร์ (api.js) → proxy.py (frontend) → backend/mainBackend.py → AI_server/mainAI.py
```

test จะต่อ `proxy.py`, `mainBackend.py` และ `mainAI.py` ตรงๆ ในโปรเซสเดียว และใช้ฐานข้อมูลชั่วคราว
ไฟล์ `backend/Userdata.db` ของจริงจึงไม่ถูกแตะ

## รัน

จากโฟลเดอร์ `Image_Page`:

```
pip install -r unit_test/requirements-test.txt
pytest unit_test -v
```

## ทดสอบกับ backend จริงข้ามเครื่อง (ไม่บังคับ)

```
set LIVE_BACKEND_URL=http://172.20.56.154:5050
pytest unit_test -m live -v
```

(PowerShell ใช้ `$env:LIVE_BACKEND_URL="http://172.20.56.154:5050"`)
จะสร้างบัญชีทดสอบค้างไว้ใน DB จริง 1 บัญชี

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `conftest.py` | ต่อสาย proxy ↔ backend ↔ AI, สร้าง DB ชั่วคราว, ล็อกอินให้ |
| `test_register_frontend_backend.py` | test การสมัครบัญชีใหม่ |
| `test_remove_background_frontend_backend_ai.py` | test ลบพื้นหลัง frontend → backend → AI |
| `test_generate_frontend_backend_ai.py` | test สร้างภาพ frontend → backend → AI → Forge (จำลอง) |
