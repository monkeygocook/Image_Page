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
| `test_generate_options.py` | LoRA / ขนาดภาพ: ค่าใน config.js ตรงกับ AI, ไปถึง Forge จริง, ค่าผิดถูกปฏิเสธ |
| `test_image_tools.py` | Adjust / Filter / Blur: ค่าจากหน้าเว็บถึง AI, AI ตรวจค่าผิด, ฟังก์ชันจริงให้ผลถูก |
| `test_queue_lanes.py` | คิว 2 สาย (gen / img) |
| `test_progress.py` | แถบ % ความคืบหน้า (Forge → AI → backend → SSE) |
| `test_job_rules.py` | งานของใครของคนนั้น, 1 คน 1 งาน, ล้างงานเก่า (JOB_TTL) |
| `test_auth_and_accounts.py` | ล็อกอิน / token, จัดการผู้ใช้ใน Staff Console, Notes / Preferences |
| `test_admin_jobs.py` | แดชบอร์ดงานใน Staff Console |
| `test_proxy_and_outputs.py` | proxy.py (ขนาดไฟล์, IP, error) และ output_store.py |
| `test_frontend_browser.py` | เปิดหน้าเว็บจริงใน Chromium: สร้างภาพ + แถบ %, ยกเลิก, อัปโหลดรูป |

## เทสหน้าเว็บในเบราว์เซอร์

ต้องติดตั้ง Playwright ก่อน (ไม่มีจะข้ามเอง):

```
pip install playwright
python -m playwright install chromium
pytest unit_test -m browser -v
```
