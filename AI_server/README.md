# AI Server Setup Guide (กันลืม)

### 🚀 วิธีการรันระบบ
ต้องใช้ **Python 3.12** (ไม่แนะนำ 3.13 เพราะ pip จะลง OpenCV 5.x ซึ่งไม่มี `cv2.CascadeClassifier` ทำให้เบลอใบหน้าพัง)

1. สร้าง venv ด้วย Python 3.12 แล้วติดตั้งไลบรารี (ต้องต่อเน็ต):
   python3.12 -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt

2. สั่งรันเซิร์ฟเวอร์ FastAPI (รันในโฟลเดอร์ AI_server):
   python -m uvicorn main:app --reload

3. เปิดดู/ทดสอบ endpoint ได้ที่ http://127.0.0.1:8000/docs

รายละเอียดการส่ง/รับของแต่ละ endpoint อยู่ใน `note.txt`

### ⚠️ โน้ตสำคัญสำหรับระบบ
- มีไฟล์ `patch.py` อยู่ที่หัวแอปเพื่อดักจับปัญหาเวอร์ชัน NumPy 2.x (Monkey Patching `np.long`) ห้ามลบเด็ดขาด
- ใช้ `onnxruntime` แบบ CPU เท่านั้น ห้ามลง `onnxruntime-gpu` คู่กัน (ไม่งั้นจะเจอ error `cublasLt64_13.dll` หาย)
- ครั้งแรกที่ลบพื้นหลัง rembg จะดาวน์โหลดโมเดล (~170MB) ไปเก็บไว้ที่ `C:\Users\<ชื่อ>\.u2net` ครั้งแรกจึงช้า
- `/generate` ต้องเปิด Stable Diffusion Forge ด้วยแฟล็ก `--api` ไว้ก่อน (ค่าเริ่มต้น `http://127.0.0.1:7860` เปลี่ยนได้ด้วย env `FORGE_URL`)
- ไม่ได้เก็บไฟล์ภาพลงดิสก์ ประมวลผลในหน่วยความจำแล้วส่งกลับ จึงไม่ต้องล้างแคชภาพ

### Endpoint ที่มี
`/health`, `/remove-background`, `/blur`, `/generate`, `/filter`, `/adjust`

### สิ่งที่ต้องทำต่อ
- ให้ Backend ดักขนาดและชนิดไฟล์ (เช่น pdf, txt หรือไฟล์เกิน 50 MB) แล้วแจ้งเตือนผู้ใช้อย่างสุภาพ
- ลดขนาดภาพที่ใหญ่มากก่อนประมวลผล
