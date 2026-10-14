# Image_Page
Project Image Page 


## ชื่อเวลาเซฟ commit
ทุกครั้งที่ คอมมิค ให้มี สกุลไฟล์นำหน้าด้วยเช่น `<py>`,`<html>` เป็นต้น


| ชื่่อ   | หน้าที่ | งานที่ต้องทำ |
|:-------:|:----------:|:-----------:|
|เมศ    | Devops   |ตรวจเช็คงาน|
|ปั้น     | Data base|สร้างฐานข้อมูล,เชื่อมฐานข้อมูลระหว่าง front-end กับ AI ได้, ส่ง get และ post ระหว่าง front-end กับ AI ได้|
|แก้ว    | AI        |สร้าง API ที่จะรับ get จาก front-end ผ่าน Data base ได้|
|วิทย์    | front end |สร้างหน้าเว็บเพจ และเชื่อม หน้าเว็บเข้ากับ database และสามารถ ส่ง get และรับ post จาก data base|


## งานที่ต้องทำ

### Global

- [x] เข้า Radmin เดียวกันเพื่อเชื่อมต่อกันภายในวงเน็ตไม่ให้ user เข้าไปข้างหลังได้ 
- [x] ฟังก์ชั่น
  - [x] ลบพื้นหลัง
  - [x] ปรับปรุงภาพ
  - [x] ฟิลเตอร์เพิ่มเบลอ
  - [x] โทน
- [x] สร้างโฟรเดอร์ database และ ซ้อนโฟลเดอร์ AI ข้างใน database อีกที เพื่อจัดการ path ได้อย่างง่ายดาย

### Frontend
- [x] สร้าง index.html
- [x] ทำหน้า หลัก
- [x] เพิ่มการใช้ฟ้ังก์ชั่น
- [x] ทำหน้าล็อคอิน
- [x] เรียกใช้ AI
- [x] เชื่อมกับฐาน Database
- [x] ดาวห์โหลดรูปได้

### Database
- [x] สร้างฐานข้อมูล
- [x] รับข้อมูลจาก index.html
- [x] รับและส่งคำขอในการใช้ AI จาก frontend ให้ AI

### AI
- [x] เชื่อม AI เข้ากับ Database
- [x] ทำให้ AI ส่งรูป กลับไปที่ Frontend ได้
- [x] สร้าง API

## การติดตั้ง

ต้องใช้ **Python 3.12** (ห้ามใช้ 3.13 เพราะจะได้ OpenCV 5 ซึ่งทำให้เบลอใบหน้าใช้ไม่ได้)

1. สร้าง virtual environment (แนะนำ)

```
   py -3.12 -m venv .venv
   .venv\Scripts\activate
```

2. ติดตั้งไลบรารีทั้งหมด (frontend, backend และ AI ใช้ไฟล์เดียวกัน)

```
   pip install -r requirements.txt
```

3. เฉพาะเครื่อง AI: ติดตั้ง [Stable Diffusion Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) แยกต่างหาก แล้วเปิดด้วยแฟล็ก `--api`

> ⚠️ ใช้ `onnxruntime` แบบ CPU เท่านั้น ห้ามติดตั้ง `onnxruntime-gpu` คู่กัน

## การรันระบบ

เปิดตามลำดับ: **AI → Backend → Frontend**

| เครื่อง | คำสั่ง | พอร์ต |
|---|---|---|
| AI | `cd AI_server` แล้ว `uvicorn mainAI:app --host 0.0.0.0 --port 8000` | 8000 |
| Backend | `cd backend` แล้ว `uvicorn mainBackend:app --host 127.0.0.1 --port 5051` (และเปิด nginx พอร์ต 5050) | 5050 |
| Frontend | `python proxy.py user` | 8080 |
| Staff Console | `python proxy.py admin` (เปิดได้เฉพาะในเครื่อง frontend) | 2026 |

### ตั้งค่า nginx (เครื่อง Backend)

nginx เปิดพอร์ต **5050** รับคำขอเฉพาะจากเครื่อง frontend แล้วส่งต่อให้ `mainBackend.py` ที่พอร์ต 5051

1. ดาวน์โหลด nginx สำหรับ Windows จาก https://nginx.org/en/download.html แล้วแตกไฟล์ เช่น ไว้ที่ `C:\nginx`
2. เปิด `C:\nginx\conf\nginx.conf` แล้ววางบล็อกนี้ไว้ **ข้างใน** `http { ... }` (หรือคัดลอกจาก `NginxCode.txt`)

```nginx
   server {
       listen 5050;
       server_name _;

       allow 26.213.29.211;          # IP เครื่อง frontend ในวง Radmin
       deny  all;

       client_max_body_size 25m;

       location /api/ {
           proxy_pass http://127.0.0.1:5051;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $http_x_forwarded_for;   # ส่ง IP ผู้ใช้ที่ proxy.py ใส่มาต่อ
           proxy_read_timeout 130s;
           proxy_send_timeout 130s;
       }

       location / {
           return 404;
       }
   }
```

3. สั่งงาน nginx (เปิด Command Prompt ในโฟลเดอร์ `C:\nginx`)

```
   start nginx            # เปิด
   nginx -t               # ตรวจว่า config เขียนถูกไหม
   nginx -s reload        # โหลด config ใหม่หลังแก้
   nginx -s stop          # ปิด
```

> ถ้า IP ของเครื่อง frontend ใน Radmin เปลี่ยน ต้องแก้บรรทัด `allow` แล้วสั่ง `nginx -s reload`

## การทดสอบ (ไม่บังคับ)

```
pip install pytest playwright
python -m playwright install chromium
pytest unit_test -v
```


### จัดทำโดย
นายสิรวิทย์ วิริยะอาทร 6710301021  
นายพรราเมศวร์ กวีวรรณ 6710301031  
นายชนน วิไลขำ 6710301042  
นายศุทธมนต์ รอดรัศมี 6710301049
