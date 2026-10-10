"""
conftest.py — ของที่ test ทุกไฟล์ในโฟลเดอร์นี้ใช้ร่วมกัน (pytest โหลดให้อัตโนมัติ)

ภาพรวมของระบบตอนใช้งานจริง (คนละเครื่อง)
    เบราว์เซอร์ (Image_index/js/api.js)
        │  POST /api/v1/auth/register   (JSON: name, email, password)
        ▼
    proxy.py        ← รันบนเครื่อง FRONTEND
        │  ส่งต่อทุก /api/... ผ่าน httpx
        ▼
    backend/fake.py ← รันบนเครื่อง BACKEND
        │
        ▼
    Userdata.db (SQLite)

ใน unit test เราไม่ใช้เครือข่ายจริง แต่ "ต่อสาย" proxy เข้ากับ backend ตรงๆ
ภายในโปรเซสเดียว (httpx.ASGITransport) และให้ backend ใช้ฐานข้อมูลชั่วคราว
ข้อมูลจริงใน backend/Userdata.db จึงไม่ถูกแตะเลย
"""
import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent      # โฟลเดอร์ Image_Page
sys.path.insert(0, str(ROOT))                     # ให้ import proxy ได้
sys.path.insert(0, str(ROOT / "backend"))         # ให้ import fake ได้

# fake.py สร้างไฟล์ "Userdata.db" ในโฟลเดอร์ปัจจุบันทันทีที่ถูก import
# จึงย้ายไปโฟลเดอร์ชั่วคราวก่อน import เพื่อไม่ให้เกิดไฟล์ขยะในโปรเจกต์
_import_dir = tempfile.mkdtemp(prefix="image_page_test_")
_old_cwd = os.getcwd()
os.chdir(_import_dir)
try:
    import fake      # backend  (backend/fake.py)
    import proxy     # frontend (proxy.py)
finally:
    os.chdir(_old_cwd)


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "live: ยิงไปที่ backend จริงผ่านเครือข่าย (ต้องตั้ง LIVE_BACKEND_URL)"
    )
    config.addinivalue_line(
        "markers", "model: โหลดโมเดล AI จริง ช้าและใช้แรมมาก (ข้ามได้ด้วย -m \"not model\")"
    )


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """ฐานข้อมูลใหม่เอี่ยมสำหรับแต่ละ test — test ไม่กระทบกันเอง"""
    path = tmp_path / "test_userdata.db"
    monkeypatch.setattr(fake, "DB", str(path))
    fake.init_db()
    return path


@pytest.fixture
def frontend(db_path, monkeypatch):
    """
    client ที่ทำตัวเหมือนเบราว์เซอร์ ยิงเข้า proxy.py (ฝั่ง frontend)
    แล้ว proxy ส่งต่อให้ fake.py (ฝั่ง backend) เหมือนตอนใช้งานจริง
    """
    to_backend = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fake.app),
        base_url="http://backend.test",
    )
    monkeypatch.setattr(proxy, "client", to_backend)

    app = proxy.build(ROOT / "Image_index")
    with TestClient(app, base_url="http://frontend.test") as c:
        yield c


@pytest.fixture
def frontend_backend_down(monkeypatch, tmp_path):
    """frontend ที่ต่อ backend ไม่ติด (จำลองเครื่อง backend ดับ/เน็ตหลุด)"""
    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    dead = httpx.AsyncClient(transport=httpx.MockTransport(refuse),
                             base_url="http://backend.test")
    monkeypatch.setattr(proxy, "client", dead)

    app = proxy.build(ROOT / "Image_index")
    with TestClient(app, base_url="http://frontend.test") as c:
        yield c
