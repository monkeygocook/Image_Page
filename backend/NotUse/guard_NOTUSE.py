"""
guard.py - ป้องกันในตัวแอป (ไม่ต้องแก้ firewall ของเครื่อง)

ทำ 2 อย่าง
  1) ปฏิเสธ (403) ทุกคำขอที่ TCP ต้นทางไม่ใช่ proxy ที่เชื่อถือ
  2) เมื่อมาจาก proxy จริง อ่าน IP ผู้ใช้จากหัว X-Forwarded-For
     เก็บไว้ที่ request.state.client_ip และพิมพ์ลง log

วิธีใช้ใน fake.py (2 บรรทัด วางต่อจาก app = FastAPI(...) และก่อน add_request_id)
    from guard import install_guard
    install_guard(app)

รัน uvicorn ต้อง "ไม่" ใช้ --proxy-headers (ไม่งั้น uvicorn จะสลับ request.client
เป็น IP ผู้ใช้ แล้ว guard จะมองว่าทุกคำขอไม่ได้มาจาก proxy)
    uvicorn fake:app --host 0.0.0.0 --port 5050 --no-proxy-headers --no-access-log

ตั้ง proxy ที่เชื่อถือได้ทาง env (คั่นด้วยจุลภาค) หรือแก้ค่าเริ่มต้นด้านล่าง
    TRUSTED_PROXIES=172.20.56.250
ทดสอบบนเครื่อง backend เอง: TRUSTED_PROXIES=172.20.56.250,127.0.0.1
"""
import ipaddress
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("uvicorn.error")   # ออกที่หน้าจอเดียวกับ log ของ uvicorn

FrontEnd_IP = "172.20.56.154"

def _norm(ip: str) -> str:
    """::ffff:1.2.3.4 -> 1.2.3.4 (กรณี uvicorn ฟังแบบ IPv6 dual-stack)"""
    return ip[7:] if ip.startswith("::ffff:") else ip


TRUSTED_PROXIES = {
    _norm(x.strip())
    for x in os.getenv("TRUSTED_PROXIES", FrontEnd_IP).split(",")
    if x.strip()
}


def _user_ip(request: Request, peer: str) -> str:
    """IP ผู้ใช้จริง — เรียกเมื่อยืนยันแล้วว่า peer คือ proxy ที่เชื่อถือ"""
    first = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    try:
        return str(ipaddress.ip_address(first))
    except ValueError:
        return peer          # ไม่มี/รูปแบบเสีย -> ใช้ IP ของ proxy แทน


def install_guard(app: FastAPI) -> None:
    @app.middleware("http")
    async def only_from_proxy(request: Request, call_next):
        peer = _norm(request.client.host) if request.client else ""

        if peer not in TRUSTED_PROXIES:
            log.warning("BLOCKED direct access from %s: %s %s",
                        peer or "?", request.method, request.url.path)
            return JSONResponse(
                {"error": {"code": "FORBIDDEN", "message": "direct access is not allowed"}},
                status_code=403,
            )

        ip = _user_ip(request, peer)
        request.state.client_ip = ip          # ใช้ใน endpoint / rate limit ได้
        response = await call_next(request)
        log.info("%s %s %s -> %s", ip, request.method, request.url.path, response.status_code)
        return response
