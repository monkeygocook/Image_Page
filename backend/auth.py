import base64
import hashlib
import hmac
import json
import time

from fastapi import Header, HTTPException, Depends
from pydantic import BaseModel

from database import get_connection


SECRET = "dev-secret-change-me"

def _hash(pw: str) -> str:
    return hashlib.sha256((SECRET + pw).encode()).hexdigest()

def _token(email: str) -> str:
    raw = json.dumps({"sub": email, "exp": time.time() + 1209600})
    sig = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:16]
    return base64.urlsafe_b64encode(f"{raw}|{sig}".encode()).decode()

def _public(u: dict) -> dict:
    return {"name": u["name"], "email": u["email"],
            "role": u["role"], "created_at": u["created_at"]}

def me_user(authorization: str | None = Header(None)) -> dict:

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "กรุณาเข้าสู่ระบบ")

    try:
        raw, sig = base64.urlsafe_b64decode(
            authorization[7:]
        ).decode().rsplit("|", 1)

        good = hmac.new(
            SECRET.encode(),
            raw.encode(),
            hashlib.sha256
        ).hexdigest()[:16]

        data = json.loads(raw)

        if not hmac.compare_digest(sig, good):
            raise Exception()

        if data["exp"] <= time.time():
            raise Exception()

        conn = get_connection()
        cur = conn.cursor()

        cur.execute(
            "SELECT * FROM users WHERE email = ?",
            (data["sub"],)
        )

        row = cur.fetchone()
        conn.close()

        if not row:
            raise Exception()

        return dict(row)

    except Exception:
        raise HTTPException(401, "เซสชันหมดอายุ")


class AuthIn(BaseModel):
    name: str | None = None
    email: str
    password: str

def staff_only(u: dict = Depends(me_user)) -> dict:
    if u["role"] != "staff":
        raise HTTPException(403, "ต้องเป็นเจ้าหน้าที่เท่านั้น")
    return u