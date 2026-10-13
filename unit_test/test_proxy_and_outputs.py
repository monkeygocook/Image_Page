"""
ทดสอบ: proxy.py (เครื่อง FRONTEND) และ AI_server/services/output_store.py

proxy.py
- ไฟล์ใหญ่เกินกำหนดถูกตัดที่ proxy ไม่ส่งต่อให้ backend
- X-Forwarded-For ที่ผู้ใช้ปลอมมาต้องไม่ถึง backend (backend ใช้ IP นี้จดว่าใครส่งงาน)
- backend ล่ม/ช้า → หน้าเว็บได้รหัส error ที่รู้จัก
- Staff Console (admin) เปิดได้เฉพาะในเครื่อง

output_store.py
- เก็บภาพล่าสุดไว้ MAX_OUTPUTS ภาพ ลบอันเก่า ชื่อไม่ชนกัน และพังแล้วไม่ทำให้คำขอพัง
"""
import os

import httpx
import pytest
from fastapi.testclient import TestClient

import proxy
from conftest import ROOT


# ======================================================================
# proxy.py
# ======================================================================

def reply(status, body: bytes, headers=None):
    """response แบบสตรีม (proxy อ่านด้วย aiter_raw เหมือนของจริง)"""
    return httpx.Response(status, headers={"content-type": "application/json", **(headers or {})},
                          stream=httpx.ByteStream(body))

@pytest.fixture
def seen(monkeypatch):
    """backend จำลอง: จดทุกคำขอที่ proxy ส่งมา"""
    log = []

    def handler(request: httpx.Request):
        log.append({"method": request.method, "url": str(request.url),
                    "headers": dict(request.headers), "body": request.content})
        return reply(200, b'{"ok": true}', {"X-Request-Id": "abc", "connection": "keep-alive"})

    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://backend.test"))
    return log


@pytest.fixture
def web(seen):
    with TestClient(proxy.build(ROOT / "Image_index"), base_url="http://frontend.test") as c:
        yield c


def test_proxy_forwards_method_path_query_and_body(web, seen):
    r = web.put("/api/v1/notes?x=1&y=two", json={"content": "hi"},
                headers={"Authorization": "Bearer t0k"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    req = seen[0]
    assert req["method"] == "PUT"
    assert req["url"].endswith("/api/v1/notes?x=1&y=two")
    assert req["body"] == b'{"content":"hi"}'
    assert req["headers"]["authorization"] == "Bearer t0k"
    assert r.headers.get("x-request-id") == "abc", "header จาก backend ไม่ถึงหน้าเว็บ"


def test_proxy_serves_frontend_files(web, seen):
    r = web.get("/")
    assert r.status_code == 200 and "<html" in r.text.lower()
    assert web.get("/js/api.js").status_code == 200
    assert seen == [], "ไฟล์หน้าเว็บไม่ควรถูกส่งไป backend"


def test_proxy_rejects_big_upload_by_content_length(web, seen):
    big = b"0" * (proxy.MAX_BODY + 1)
    r = web.post("/api/v1/remove-background", content=big,
                 headers={"content-type": "application/octet-stream"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert seen == [], "ไฟล์ใหญ่เกินกำหนดถูกส่งต่อให้ backend"


def test_proxy_rejects_big_chunked_upload(web, seen):
    """ไม่มี Content-Length (ส่งแบบ chunked) ก็ต้องนับขนาดเองแล้วตัด"""
    def chunks():
        for _ in range(proxy.MAX_BODY // (1024 * 1024) + 2):
            yield b"0" * (1024 * 1024)
    r = web.post("/api/v1/remove-background", content=chunks(),
                 headers={"content-type": "application/octet-stream"})
    assert r.status_code == 413
    assert seen == []


def test_proxy_replaces_spoofed_forwarded_for(web, seen):
    web.get("/api/v1/health", headers={"X-Forwarded-For": "6.6.6.6",
                                       "X-Real-IP": "7.7.7.7",
                                       "X-Forwarded-Proto": "https"})
    h = seen[0]["headers"]
    assert "6.6.6.6" not in h.get("x-forwarded-for", ""), "IP ปลอมจากผู้ใช้หลุดถึง backend"
    assert h.get("x-forwarded-for") == "testclient", "proxy ต้องใส่ IP จริงของผู้ใช้เอง"
    assert "x-real-ip" not in h and "x-forwarded-proto" not in h


def test_proxy_backend_down(monkeypatch):
    def down(request):
        raise httpx.ConnectError("refused", request=request)
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.MockTransport(down), base_url="http://backend.test"))
    with TestClient(proxy.build(ROOT / "Image_index")) as c:
        r = c.get("/api/v1/health")
    assert r.status_code == 502 and r.json()["error"]["code"] == "BACKEND_DOWN"


def test_proxy_backend_timeout(monkeypatch):
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.MockTransport(slow), base_url="http://backend.test"))
    with TestClient(proxy.build(ROOT / "Image_index")) as c:
        r = c.get("/api/v1/health")
    assert r.status_code == 504 and r.json()["error"]["code"] == "TIMEOUT"


def test_proxy_passes_backend_errors_through(monkeypatch):
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: reply(
            409, b'{"error": {"code": "JOB_ACTIVE"}}')), base_url="http://backend.test"))
    with TestClient(proxy.build(ROOT / "Image_index")) as c:
        r = c.post("/api/v1/jobs/generate", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "JOB_ACTIVE"


def test_admin_console_only_on_localhost():
    assert proxy.TARGETS["admin"]["host"] == "127.0.0.1", (
        "Staff Console เปิดให้เครื่องอื่นในวง LAN เข้าได้"
    )
    assert proxy.TARGETS["admin"]["dir"].name == "admin_panel"
    assert proxy.TARGETS["user"]["dir"].name == "Image_index"


def test_admin_proxy_serves_staff_console(seen):
    with TestClient(proxy.build(ROOT / "admin_panel")) as c:
        r = c.get("/")
    assert r.status_code == 200 and "Staff Console" in r.text


# ======================================================================
# output_store.py
# ======================================================================

@pytest.fixture
def store(ai_main, tmp_path, monkeypatch):
    from services import output_store
    monkeypatch.setattr(output_store, "OUTPUT_DIR", tmp_path / "outputs")
    monkeypatch.setattr(output_store, "MAX_OUTPUTS", 3)
    return output_store


def test_output_saved_as_png(store):
    store.save_output("generate", b"\x89PNG-data")
    files = list(store.OUTPUT_DIR.glob("*.png"))
    assert len(files) == 1
    assert files[0].read_bytes() == b"\x89PNG-data"
    assert "_generate_" in files[0].name


def test_output_keeps_only_latest(store):
    for i in range(7):
        store.save_output("blur", f"img{i}".encode())
    files = sorted(store.OUTPUT_DIR.glob("*.png"), key=lambda p: p.name)
    assert len(files) == 3, f"เก็บไว้ {len(files)} ไฟล์ ควรเหลือ MAX_OUTPUTS=3"
    assert {f.read_bytes() for f in files} == {b"img4", b"img5", b"img6"}, (
        "ภาพที่บันทึกภายในวินาทีเดียวกันถูกลบผิดลำดับ — output_store.py เรียงไฟล์ตามชื่อ "
        "(เวลาถึงวินาที + ชื่องาน + เลขสุ่ม) เลขสุ่มจึงเป็นตัวตัดสินว่าอันไหน 'เก่ากว่า'"
    )
    assert not list(store.OUTPUT_DIR.glob("*.tmp")), "มีไฟล์ .tmp ค้าง"


def test_output_names_do_not_collide(store, monkeypatch):
    monkeypatch.setattr(store, "MAX_OUTPUTS", 100)
    for i in range(30):
        store.save_output("filter", str(i).encode())           # ภายในวินาทีเดียวกัน
    assert len(list(store.OUTPUT_DIR.glob("*.png"))) == 30


def test_output_kind_cannot_escape_folder(store, tmp_path):
    store.save_output("../../evil", b"x")
    store.save_output("a/b\\c", b"y")
    assert not list(tmp_path.glob("*.png")), "ไฟล์หลุดออกนอกโฟลเดอร์ outputs"
    names = [p.name for p in store.OUTPUT_DIR.glob("*.png")]
    assert len(names) == 2 and all("/" not in n and "\\" not in n and ".." not in n for n in names)


def test_output_failure_does_not_raise(store, monkeypatch, tmp_path):
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("file")
    monkeypatch.setattr(store, "OUTPUT_DIR", blocker / "outputs")   # สร้างโฟลเดอร์ไม่ได้
    store.save_output("generate", b"x")                             # ต้องไม่ error


def test_ai_saves_result_after_each_job(ai_main, store, monkeypatch):
    monkeypatch.setattr(ai_main, "apply_filter", lambda *a, **k: b"\x89PNG-filtered")
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, "PNG")
    r = TestClient(ai_main.app).post("/filter", files={"image": ("p.png", buf.getvalue(), "image/png")},
                                     data={"filter_name": "sepia"})
    assert r.status_code == 200
    files = list(store.OUTPUT_DIR.glob("*.png"))
    assert len(files) == 1 and files[0].read_bytes() == b"\x89PNG-filtered"
