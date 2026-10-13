"""
ทดสอบ: บัญชีผู้ใช้

ส่วนที่ 1  ล็อกอิน / token          (/api/v1/auth/*)
ส่วนที่ 2  จัดการผู้ใช้ใน Staff Console (/api/v1/admin/users*)
ส่วนที่ 3  Notes / Preferences       (/api/v1/notes, /api/v1/preferences)

ทุก request วิ่งผ่าน proxy.py → mainBackend.py เหมือนเบราว์เซอร์ และใช้ DB ชั่วคราว
"""
import base64
import json
import sqlite3
import time

import pytest

import mainBackend as backend

PW = "Password123"


def register(client, email, name=None):
    r = client.post("/api/v1/auth/register", json={"name": name or email.split("@")[0],
                                                     "email": email, "password": PW})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def make_staff(email):
    conn = sqlite3.connect(backend.DB)
    conn.execute("UPDATE users SET role='staff' WHERE email=?", (email,))
    conn.commit()
    conn.close()


def role_of(email):
    conn = sqlite3.connect(backend.DB)
    row = conn.execute("SELECT role FROM users WHERE email=?", (email,)).fetchone()
    conn.close()
    return row[0] if row else None


def forge_token(payload: dict, sig="0" * 16) -> str:
    raw = json.dumps(payload)
    return base64.urlsafe_b64encode(f"{raw}|{sig}".encode()).decode()


# ======================================================================
# ส่วนที่ 1  ล็อกอิน / token
# ======================================================================

def test_login_success_returns_user_and_token(frontend):
    register(frontend, "ann@example.com", "Ann")
    r = frontend.post("/api/v1/auth/login", json={"email": "ann@example.com", "password": PW})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["user"]["email"] == "ann@example.com" and d["user"]["name"] == "Ann"
    assert d["user"]["role"] == "user"
    assert "pw" not in d["user"], "ส่งรหัสผ่าน (hash) กลับไปให้หน้าเว็บ"
    me = frontend.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {d['access_token']}"})
    assert me.status_code == 200 and me.json()["user"]["email"] == "ann@example.com"


def test_login_wrong_password(frontend):
    register(frontend, "bob@example.com")
    r = frontend.post("/api/v1/auth/login", json={"email": "bob@example.com", "password": "WrongPass99"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_login_unknown_email_gives_same_error(frontend):
    """ไม่บอกว่าอีเมลนี้มีในระบบหรือไม่ (กันการไล่เดาอีเมล)"""
    register(frontend, "real@example.com")
    wrong_pw = frontend.post("/api/v1/auth/login", json={"email": "real@example.com", "password": "nope12345"})
    no_user = frontend.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "nope12345"})
    assert no_user.status_code == wrong_pw.status_code == 401
    assert no_user.json()["error"]["code"] == wrong_pw.json()["error"]["code"]
    assert no_user.json()["error"]["message"] == wrong_pw.json()["error"]["message"]


def test_login_missing_fields(frontend):
    r = frontend.post("/api/v1/auth/login", json={"email": "x@example.com"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("header", [
    None,
    "Bearer",
    "Bearer not-base64-!!!",
    "Basic dXNlcjpwYXNz",
    "Bearer " + base64.urlsafe_b64encode(b"no separator").decode(),
])
def test_me_rejects_missing_or_garbage_token(frontend, header):
    h = {"Authorization": header} if header else {}
    r = frontend.get("/api/v1/auth/me", headers=h)
    assert r.status_code == 401, f"{header!r} → {r.status_code}"


def test_me_rejects_forged_signature(frontend):
    """แก้ token เป็นอีเมลคนอื่นเองโดยไม่มีลายเซ็นที่ถูก → ต้องไม่ผ่าน"""
    register(frontend, "victim@example.com")
    fake = forge_token({"sub": "victim@example.com", "exp": time.time() + 3600})
    r = frontend.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {fake}"})
    assert r.status_code == 401


def test_me_rejects_expired_token(frontend):
    register(frontend, "old@example.com")
    raw = json.dumps({"sub": "old@example.com", "exp": time.time() - 1})
    sig = backend.hmac.new(backend.SECRET.encode(), raw.encode(), backend.hashlib.sha256).hexdigest()[:16]
    tok = base64.urlsafe_b64encode(f"{raw}|{sig}".encode()).decode()
    r = frontend.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 401


def test_token_stops_working_after_account_deleted(frontend):
    h = register(frontend, "gone@example.com")
    conn = sqlite3.connect(backend.DB)
    conn.execute("DELETE FROM users WHERE email='gone@example.com'")
    conn.commit()
    conn.close()
    assert frontend.get("/api/v1/auth/me", headers=h).status_code == 401


def test_logout_needs_token(frontend):
    h = register(frontend, "out@example.com")
    assert frontend.post("/api/v1/auth/logout", headers=h).status_code == 204
    assert frontend.post("/api/v1/auth/logout").status_code == 401


# ======================================================================
# ส่วนที่ 2  จัดการผู้ใช้ (Staff Console)
# ======================================================================

@pytest.fixture
def staff(frontend):
    h = register(frontend, "boss@example.com", "Boss")
    make_staff("boss@example.com")
    return h


def test_admin_api_needs_staff(frontend):
    user = register(frontend, "plain@example.com")
    register(frontend, "target@example.com")
    calls = [("GET", "/api/v1/admin/users", None),
             ("PUT", "/api/v1/admin/users/target@example.com/role", {"role": "staff"}),
             ("PATCH", "/api/v1/admin/users/target@example.com/role", {"role": "staff"}),
             ("DELETE", "/api/v1/admin/users/target@example.com", None)]
    for method, path, body in calls:
        assert frontend.request(method, path, json=body).status_code == 401, f"{method} {path} (ไม่ล็อกอิน)"
        r = frontend.request(method, path, json=body, headers=user)
        assert r.status_code == 403, f"{method} {path} → {r.status_code} (user ธรรมดาทำได้)"
    assert role_of("target@example.com") == "user"
    assert role_of("plain@example.com") == "user", "user ธรรมดาเลื่อนสิทธิ์ตัวเองได้"


def test_admin_list_users_without_passwords(frontend, staff):
    register(frontend, "u1@example.com")
    r = frontend.get("/api/v1/admin/users", headers=staff)
    assert r.status_code == 200
    users = r.json()["users"]
    assert {u["email"] for u in users} == {"boss@example.com", "u1@example.com"}
    assert all("pw" not in u for u in users), "รายชื่อผู้ใช้มี hash รหัสผ่านติดไปด้วย"


@pytest.mark.parametrize("method", ["PUT", "PATCH"])
def test_admin_promote_and_demote(frontend, staff, method):
    register(frontend, "mia@example.com")
    r = frontend.request(method, "/api/v1/admin/users/mia@example.com/role",
                         json={"role": "staff"}, headers=staff)
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "staff" and role_of("mia@example.com") == "staff"
    r = frontend.request(method, "/api/v1/admin/users/mia@example.com/role",
                         json={"role": "user"}, headers=staff)
    assert r.status_code == 200 and role_of("mia@example.com") == "user"


def test_promoted_user_can_use_admin_api(frontend, staff):
    h = register(frontend, "new.staff@example.com")
    assert frontend.get("/api/v1/admin/users", headers=h).status_code == 403
    frontend.put("/api/v1/admin/users/new.staff@example.com/role", json={"role": "staff"}, headers=staff)
    assert frontend.get("/api/v1/admin/users", headers=h).status_code == 200


def test_admin_invalid_role(frontend, staff):
    register(frontend, "kim@example.com")
    r = frontend.put("/api/v1/admin/users/kim@example.com/role", json={"role": "god"}, headers=staff)
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_ROLE"
    assert role_of("kim@example.com") == "user"


def test_admin_unknown_user(frontend, staff):
    r = frontend.put("/api/v1/admin/users/nobody@example.com/role", json={"role": "staff"}, headers=staff)
    assert r.status_code == 404
    r = frontend.delete("/api/v1/admin/users/nobody@example.com", headers=staff)
    assert r.status_code == 404


def test_admin_cannot_demote_or_delete_self(frontend, staff):
    r = frontend.put("/api/v1/admin/users/boss@example.com/role", json={"role": "user"}, headers=staff)
    assert r.status_code == 409 and r.json()["error"]["code"] == "SELF_DEMOTE"
    r = frontend.delete("/api/v1/admin/users/boss@example.com", headers=staff)
    assert r.status_code == 409 and r.json()["error"]["code"] == "SELF_DELETE"
    assert role_of("boss@example.com") == "staff"


def test_admin_delete_user_removes_their_data(frontend, staff):
    h = register(frontend, "leaving@example.com")
    frontend.put("/api/v1/notes", json={"content": "my notes"}, headers=h)
    frontend.put("/api/v1/preferences", json={"lang": "en", "tabs": ["back"]}, headers=h)

    r = frontend.delete("/api/v1/admin/users/leaving@example.com", headers=staff)
    assert r.status_code == 204
    assert role_of("leaving@example.com") is None
    conn = sqlite3.connect(backend.DB)
    left = [conn.execute(f"SELECT COUNT(*) FROM {t} WHERE email=?", ("leaving@example.com",)).fetchone()[0]
            for t in ("notes", "preferences")]
    conn.close()
    assert left == [0, 0], "ลบผู้ใช้แล้ว notes / preferences ยังค้างอยู่"
    assert frontend.get("/api/v1/auth/me", headers=h).status_code == 401
    # สมัครอีเมลเดิมใหม่ได้ และไม่เห็นข้อมูลเก่า
    h2 = register(frontend, "leaving@example.com")
    assert frontend.get("/api/v1/notes", headers=h2).json()["content"] == ""


def test_email_with_special_chars_in_url(frontend, staff):
    register(frontend, "a+tag@example.com")
    r = frontend.put("/api/v1/admin/users/a%2Btag%40example.com/role", json={"role": "staff"}, headers=staff)
    assert r.status_code == 200, r.text
    assert role_of("a+tag@example.com") == "staff"


# ======================================================================
# ส่วนที่ 3  Notes / Preferences
# ======================================================================

def test_notes_default_empty_then_saved(frontend):
    h = register(frontend, "noter@example.com")
    assert frontend.get("/api/v1/notes", headers=h).json() == {"content": ""}
    assert frontend.put("/api/v1/notes", json={"content": "สวัสดี\nline 2"}, headers=h).status_code == 200
    assert frontend.get("/api/v1/notes", headers=h).json()["content"] == "สวัสดี\nline 2"
    frontend.put("/api/v1/notes", json={"content": "updated"}, headers=h)
    assert frontend.get("/api/v1/notes", headers=h).json()["content"] == "updated"


def test_notes_are_private(frontend):
    a = register(frontend, "na@example.com")
    b = register(frontend, "nb@example.com")
    frontend.put("/api/v1/notes", json={"content": "A's secret"}, headers=a)
    assert frontend.get("/api/v1/notes", headers=b).json()["content"] == ""
    frontend.put("/api/v1/notes", json={"content": "B"}, headers=b)
    assert frontend.get("/api/v1/notes", headers=a).json()["content"] == "A's secret"


def test_preferences_default_then_saved(frontend):
    h = register(frontend, "pref@example.com")
    assert frontend.get("/api/v1/preferences", headers=h).json() == {"lang": "th", "tabs": None}
    tabs = ["genimage", "back", "blur"]
    assert frontend.put("/api/v1/preferences", json={"lang": "en", "tabs": tabs}, headers=h).status_code == 200
    assert frontend.get("/api/v1/preferences", headers=h).json() == {"lang": "en", "tabs": tabs}


def test_preferences_are_private(frontend):
    a = register(frontend, "pa@example.com")
    b = register(frontend, "pb@example.com")
    frontend.put("/api/v1/preferences", json={"lang": "en", "tabs": ["blur"]}, headers=a)
    assert frontend.get("/api/v1/preferences", headers=b).json() == {"lang": "th", "tabs": None}


def test_notes_and_prefs_need_login(frontend):
    for method, path in [("GET", "/api/v1/notes"), ("PUT", "/api/v1/notes"),
                         ("GET", "/api/v1/preferences"), ("PUT", "/api/v1/preferences")]:
        r = frontend.request(method, path, json={} if method == "PUT" else None)
        assert r.status_code == 401, f"{method} {path} → {r.status_code}"
