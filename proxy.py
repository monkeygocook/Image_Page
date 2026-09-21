"""
Reverse proxy + static server  (รันบนเครื่อง FRONTEND)
  python proxy.py user    -> http://0.0.0.0:8080    (Image_Page, ผู้ใช้ทั่วไป)
  python proxy.py admin   -> http://127.0.0.1:8090  (admin_panel, เปิดได้เฉพาะในเครื่องนี้)
ทุก request ที่ขึ้นต้นด้วย /api จะถูกส่งต่อไป backend

เปลี่ยน backend ได้ทาง env โดยไม่ต้องแก้โค้ด:
  BACKEND_URL=http://172.20.56.154:5050 python proxy.py user
"""
import os
import sys
from pathlib import Path

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
BACKEND = os.getenv("BACKEND_URL", "http://172.20.56.154:5050")

# ไฟล์สูงสุดที่ระบบรับคือ 20 MB + ส่วนหัวของ multipart
MAX_BODY = 25 * 1024 * 1024

# หัวฝั่งตอบกลับที่ไม่ส่งต่อ (content-encoding ต้องส่งต่อ เพราะเราส่งไบต์ดิบ aiter_raw)
HOP = {"content-length", "transfer-encoding", "connection", "keep-alive"}

# หัวฝั่งคำขอที่ตัดทิ้ง — X-Forwarded-For ของผู้ใช้ห้ามผ่าน (ปลอมได้) เราใส่เองจาก TCP จริง
DROP_REQ = {
    b"host", b"content-length", b"transfer-encoding", b"connection", b"keep-alive",
    b"x-forwarded-for", b"x-real-ip", b"x-forwarded-proto",
}

TARGETS = {
    "user":  {"dir": ROOT / "Image_index", "host": "0.0.0.0",   "port": 8080},
    "admin": {"dir": ROOT / "admin_panel", "host": "127.0.0.1", "port": 8090},
}

# connect=5: ถ้าหลังบ้านไม่ตอบ (ล่ม/โดนบล็อก) รู้ใน 5 วินาที ไม่ต้องรอ 180
client = httpx.AsyncClient(base_url=BACKEND, timeout=httpx.Timeout(180.0, connect=5.0))


def error(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


async def api_proxy(request):
    # 1) จำกัดขนาดก่อนอ่านเข้า memory
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BODY:
        return error("FILE_TOO_LARGE", "ไฟล์ใหญ่เกินกำหนด", 413)

    body = bytearray()
    async for chunk in request.stream():        # กันกรณีไม่มี content-length (chunked)
        body.extend(chunk)
        if len(body) > MAX_BODY:
            return error("FILE_TOO_LARGE", "ไฟล์ใหญ่เกินกำหนด", 413)

    # 2) ประกอบคำขอ + ใส่ IP ผู้ใช้จริงให้หลังบ้าน
    url = httpx.URL(path=request.url.path, query=request.url.query.encode())
    headers = [(k, v) for k, v in request.headers.raw if k.lower() not in DROP_REQ]
    ip = request.client.host if request.client else "unknown"
    headers.append((b"x-forwarded-for", ip.encode()))
    req = client.build_request(request.method, url, headers=headers, content=bytes(body))

    # 3) ส่งต่อ + แยกชนิด error (Timeout ต้องมาก่อน เพราะเป็นลูกของ TransportError)
    try:
        r = await client.send(req, stream=True)
    except httpx.TimeoutException:
        return error("TIMEOUT", "ระบบประมวลผลตอบช้าเกินไป", 504)
    except httpx.TransportError:
        return error("BACKEND_DOWN", "เชื่อมต่อระบบประมวลผลไม่ได้", 502)

    out = {k: v for k, v in r.headers.items() if k.lower() not in HOP}
    return StreamingResponse(
        r.aiter_raw(), status_code=r.status_code, headers=out,
        background=BackgroundTask(r.aclose),
    )


def build(static_dir: Path) -> Starlette:
    return Starlette(routes=[
        Route("/api/{rest:path}", api_proxy,
              methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
        Mount("/", app=StaticFiles(directory=static_dir, html=True)),
    ])


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "user"
    if which not in TARGETS:
        sys.exit(f"ใช้: python proxy.py [user|admin]  (ได้รับ: {which})")
    t = TARGETS[which]
    if not t["dir"].is_dir():
        sys.exit(f"ไม่พบโฟลเดอร์: {t['dir']}")
    print(f"[{which}] {t['dir'].name}  ->  http://{t['host']}:{t['port']}   api -> {BACKEND}")
    uvicorn.run(build(t["dir"]), host=t["host"], port=t["port"])
