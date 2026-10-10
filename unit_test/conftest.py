"""
conftest.py — ของที่ test ทุกไฟล์ในโฟลเดอร์นี้ใช้ร่วมกัน (pytest โหลดให้อัตโนมัติ)

เส้นทางตอนใช้งานจริง (คนละเครื่อง)
    เบราว์เซอร์ (Image_index/js/api.js)
        → proxy.py               (เครื่อง FRONTEND)
        → backend/mainBackend.py (เครื่อง BACKEND)  + Userdata.db
        → AI_server/mainAI.py    (เครื่อง AI)
        → services/*.py  (+ Stable Diffusion Forge สำหรับ /generate)

ใน unit test ทุกส่วนรันในโปรเซสเดียว ต่อสายกันด้วย httpx.ASGITransport
ไม่ใช้เครือข่ายจริง ไม่แตะ backend/Userdata.db ของจริง
"""
import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
AI_DIR = ROOT / "AI_server"
sys.path.insert(0, str(ROOT))                 # proxy
sys.path.insert(0, str(ROOT / "backend"))     # mainBackend

# mainBackend.py สร้าง "Userdata.db" ในโฟลเดอร์ปัจจุบันทันทีที่ import → ย้ายไปโฟลเดอร์ชั่วคราวก่อน
_old_cwd = os.getcwd()
os.chdir(tempfile.mkdtemp(prefix="image_page_test_"))
try:
    import mainBackend as backend
    import proxy
finally:
    os.chdir(_old_cwd)

TEST_EMAIL = "tester@example.com"
TEST_PASSWORD = "Password123"


def pytest_configure(config):
    config.addinivalue_line("markers", "live: ยิงไปที่ backend จริงผ่านเครือข่าย (ต้องตั้ง LIVE_BACKEND_URL)")
    config.addinivalue_line("markers", "model: โหลดโมเดล AI จริง ช้าและใช้แรมมาก (ข้ามได้ด้วย -m \"not model\")")


def _refuse(request):
    raise httpx.ConnectError("connection refused", request=request)


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """ฐานข้อมูลใหม่สำหรับแต่ละ test"""
    path = tmp_path / "test_userdata.db"
    monkeypatch.setattr(backend, "DB", str(path))
    backend.init_db()
    return path


@pytest.fixture
def frontend(db_path, monkeypatch):
    """
    client ที่ทำตัวเหมือนเบราว์เซอร์ ยิงเข้า proxy.py → mainBackend.py
    ค่าเริ่มต้น: เครื่อง AI "ต่อไม่ติด" (ใช้ fixture ai_connected เพื่อต่อ AI จริง)
    """
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.ASGITransport(app=backend.app), base_url="http://backend.test"))
    monkeypatch.setattr(backend, "_ai_client", httpx.AsyncClient(
        transport=httpx.MockTransport(_refuse), base_url="http://ai.test"))

    with TestClient(proxy.build(ROOT / "Image_index"), base_url="http://frontend.test") as c:
        yield c


@pytest.fixture
def logged_in(frontend):
    """frontend ที่สมัคร + ล็อกอินแล้ว ทุก request แนบ Bearer token เหมือน api.js"""
    res = frontend.post("/api/v1/auth/register",
                        json={"name": "tester", "email": TEST_EMAIL, "password": TEST_PASSWORD})
    assert res.status_code == 200, res.text
    frontend.headers["Authorization"] = f"Bearer {res.json()['access_token']}"
    return frontend


@pytest.fixture
def ai_main():
    """import AI_server/mainAI.py (ต้องมีไลบรารีของ AI ติดตั้งอยู่)"""
    for lib in ("rembg", "cv2", "numpy", "multipart"):
        pytest.importorskip(lib, reason=f"ยังไม่ได้ติดตั้ง {lib} (ดู AI_server/requirements.txt)")
    if str(AI_DIR) not in sys.path:
        sys.path.insert(0, str(AI_DIR))
    import mainAI
    return mainAI


@pytest.fixture
def ai_connected(frontend, ai_main, monkeypatch):
    """ต่อ backend._ai_client เข้ากับ mainAI.app ในโปรเซสเดียวกัน"""
    monkeypatch.setattr(backend, "_ai_client", httpx.AsyncClient(
        transport=httpx.ASGITransport(app=ai_main.app), base_url="http://ai.test",
        timeout=backend._ai_client.timeout))
    return ai_main


@pytest.fixture
def frontend_backend_down(monkeypatch):
    """frontend ที่ต่อ backend ไม่ติด"""
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        transport=httpx.MockTransport(_refuse), base_url="http://backend.test"))
    with TestClient(proxy.build(ROOT / "Image_index"), base_url="http://frontend.test") as c:
        yield c
