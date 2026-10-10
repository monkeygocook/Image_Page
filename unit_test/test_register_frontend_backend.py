"""
ทดสอบ: สมัครบัญชีใหม่จาก frontend แล้วข้อมูลไปถูกเก็บที่ backend ได้จริงไหม

เส้นทางที่ทดสอบ  เบราว์เซอร์ → proxy.py → backend/fake.py → SQLite
รัน (จากโฟลเดอร์ Image_Page):   pytest unit_test -v
"""
import os
import re
import sqlite3
import uuid
from pathlib import Path

import httpx
import pytest

import fake

ROOT = Path(__file__).resolve().parent.parent
REGISTER = "/api/v1/auth/register"


# ---------- ตัวช่วย ----------

def register(client, name="สมชาย", email="somchai@example.com", password="Password123"):
    """ส่ง request แบบเดียวกับ auth.register() ใน Image_index/js/api.js ทุกประการ"""
    return client.post(
        REGISTER,
        json={"name": name, "email": email, "password": password},
        headers={"Content-Type": "application/json"},
    )


def users_in_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM users")]
    conn.close()
    return rows


# ---------- กรณีสำเร็จ ----------

def test_register_returns_user_and_token(frontend):
    res = register(frontend)

    assert res.status_code == 200
    body = res.json()
    assert body["user"]["email"] == "somchai@example.com"
    assert body["user"]["name"] == "สมชาย"
    assert body["user"]["role"] == "user"
    assert body["access_token"]                # frontend ต้องได้ token ไปเก็บ
    assert "pw" not in body["user"]            # ห้ามส่งรหัสผ่านกลับไปหน้าเว็บ
    assert "password" not in body["user"]


def test_new_account_is_saved_in_backend_database(frontend, db_path):
    register(frontend)

    rows = users_in_db(db_path)
    assert len(rows) == 1
    saved = rows[0]
    assert saved["email"] == "somchai@example.com"
    assert saved["name"] == "สมชาย"
    assert saved["role"] == "user"
    assert saved["created_at"]


def test_password_is_stored_hashed_not_plain_text(frontend, db_path):
    register(frontend, password="Password123")

    saved = users_in_db(db_path)[0]
    assert saved["pw"] != "Password123"
    assert saved["pw"] == fake._hash("Password123")


def test_registered_account_can_log_in_and_call_me(frontend):
    """พิสูจน์ว่าข้อมูลถูกเก็บจริง ไม่ใช่แค่ตอบ 200 กลับมาเฉยๆ"""
    register(frontend, email="new@example.com", password="Password123")

    login = frontend.post("/api/v1/auth/login",
                          json={"email": "new@example.com", "password": "Password123"})
    assert login.status_code == 200
    token = login.json()["access_token"]

    me = frontend.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "new@example.com"


def test_name_defaults_to_email_prefix_when_empty(frontend, db_path):
    res = frontend.post(REGISTER, json={"email": "nong@example.com", "password": "Password123"})

    assert res.status_code == 200
    assert res.json()["user"]["name"] == "nong"
    assert users_in_db(db_path)[0]["name"] == "nong"


def test_request_id_header_passes_back_through_proxy(frontend):
    """api.js อ่าน X-Request-Id ไว้ใช้แจ้ง error — proxy ต้องส่งหัวนี้กลับมาครบ"""
    res = register(frontend)
    assert res.headers.get("X-Request-Id")


# ---------- กรณีผิดพลาด (frontend ต้องได้ error ที่อ่านออก และ DB ต้องไม่เพี้ยน) ----------

def test_duplicate_email_is_rejected(frontend, db_path):
    register(frontend, email="dup@example.com")
    res = register(frontend, email="dup@example.com", name="คนที่สอง")

    assert res.status_code == 409
    assert res.json()["error"]["code"] == "EMAIL_TAKEN"   # api.js แปลรหัสนี้เป็นข้อความให้ผู้ใช้
    rows = users_in_db(db_path)
    assert len(rows) == 1
    assert rows[0]["name"] == "สมชาย"                   # ข้อมูลเดิมไม่ถูกทับ


def test_short_password_is_rejected_and_not_saved(frontend, db_path):
    res = register(frontend, password="1234567")         # 7 ตัว

    assert res.status_code == 422
    assert res.json()["error"]["code"] == "WEAK_PASSWORD"
    assert users_in_db(db_path) == []


def test_missing_email_returns_validation_error(frontend, db_path):
    res = frontend.post(REGISTER, json={"name": "a", "password": "Password123"})

    assert res.status_code == 422
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert users_in_db(db_path) == []


def test_frontend_gets_clear_error_when_backend_is_down(frontend_backend_down):
    res = register(frontend_backend_down)

    assert res.status_code == 502
    assert res.json()["error"]["code"] == "BACKEND_DOWN"


# ---------- สัญญาระหว่างสองฝั่ง (contract) ----------

def test_frontend_register_endpoint_exists_in_backend():
    """ถ้าใครเปลี่ยน path ฝั่งใดฝั่งหนึ่งแล้วลืมอีกฝั่ง test นี้จะพัง"""
    config_js = (ROOT / "Image_index" / "js" / "config.js").read_text(encoding="utf-8")
    m = re.search(r'register:\s*"([^"]+)"', config_js)
    assert m, "ไม่พบ ENDPOINTS.register ใน config.js"
    frontend_path = m.group(1)

    backend_routes = {(r.path, m) for r in fake.app.routes for m in getattr(r, "methods", [])}
    assert (frontend_path, "POST") in backend_routes


# ---------- ทดสอบกับเครื่องจริง (ข้ามโดยปริยาย) ----------

LIVE_URL = os.getenv("LIVE_BACKEND_URL")


@pytest.mark.live
@pytest.mark.skipif(not LIVE_URL, reason="ตั้ง LIVE_BACKEND_URL เพื่อทดสอบกับ backend จริง")
def test_live_register_on_real_backend():
    """
    integration test ข้ามเครื่องจริง เช่น
        set LIVE_BACKEND_URL=http://172.20.56.154:5050      (Windows cmd)
        pytest unit_test -m live -v
    หมายเหตุ: จะสร้างบัญชีทดสอบค้างไว้ใน DB จริง 1 บัญชี (ลบได้จาก admin panel)
    """
    email = f"test-{uuid.uuid4().hex[:8]}@example.com"
    with httpx.Client(base_url=LIVE_URL, timeout=10) as c:
        res = c.post(REGISTER, json={"name": "unit-test", "email": email,
                                     "password": "Password123"})
        assert res.status_code == 200, res.text
        assert res.json()["user"]["email"] == email

        login = c.post("/api/v1/auth/login", json={"email": email, "password": "Password123"})
        assert login.status_code == 200
