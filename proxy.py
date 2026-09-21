"""
Reverse proxy + static server
  python proxy.py user    -> http://127.0.0.1:8080  (Image_Page)
  python proxy.py admin   -> http://127.0.0.1:8090  (admin_panel)
ทุก request ที่ขึ้นต้นด้วย /api จะถูกส่งต่อไป backend ที่ 5050
"""
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
BACKEND = "http://172.20.56.154:5050"
HOP = {"content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"}

TARGETS = {
    "user":  {"dir": ROOT / "Image_index", "port": 8080},
    "admin": {"dir": ROOT / "admin_panel", "port": 8090},
}


client = httpx.AsyncClient(base_url=BACKEND, timeout=180.0)


async def api_proxy(request):
    url = httpx.URL(path=request.url.path, query=request.url.query.encode())
    headers = [(k, v) for k, v in request.headers.raw if k.lower() != b"host"]
    req = client.build_request(
        request.method, url, headers=headers, content=await request.body()
    )
    try:
        r = await client.send(req, stream=True)
    except httpx.ConnectError:
        return JSONResponse(
            {"error": {"code": "BACKEND_DOWN", "message": "เชื่อมต่อระบบประมวลผลไม่ได้"}},
            status_code=502,
        )
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
    print(f"[{which}] {t['dir'].name}  ->  http://127.0.0.1:{t['port']}   api -> {BACKEND}")
    uvicorn.run(build(t["dir"]), host="0.0.0.0", port=t["port"])