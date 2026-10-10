"""
ทดสอบ: frontend สร้างภาพจากข้อความ (AI_server/services/generator.py) ผ่าน backend ได้ไหม

เส้นทางที่ควรเป็น
    เบราว์เซอร์ (api.js)  POST /api/v1/generate   JSON {prompt, negative_prompt?}
        → proxy.py (frontend)
        → backend/mainBackend.py
        → AI_server/mainAI.py   POST /generate   JSON {prompt, negative_prompt, seed}
        → services/generator.py  generate_image()
        → Stable Diffusion Forge  POST /sdapi/v1/txt2img

แบ่งเป็นชั้น เพื่อให้รู้ว่าพังที่ช่วงไหน
    ชั้น 1  frontend → backend
    ชั้น 2  backend  → AI
    ชั้น 3  AI endpoint /generate
    ชั้น 4  generator.py → Forge   (Forge เป็นตัวจำลอง ไม่ต้องเปิด Forge จริง)
    ชั้น 5  สัญญาที่ตกลงกันไว้ (ขนาดภาพ, timeout)

รัน (จากโฟลเดอร์ Image_Page):   pytest unit_test/test_generate_frontend_backend_ai.py -v
"""
import base64
import io
import re
import sys
from pathlib import Path

import pytest
import requests
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
AI_DIR = ROOT / "AI_server"
ENDPOINT = "/api/v1/generate"


def make_png(size=(512, 768), color=(30, 120, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


FORGE_PNG = make_png()          # ภาพที่ Forge จำลองจะตอบกลับ


def send_like_frontend(client, prompt="a cat on the moon", negative="blurry"):
    """ส่ง JSON แบบเดียวกับ api.js process() ของแท็บ genimage"""
    payload = {"prompt": prompt}
    if negative:
        payload["negative_prompt"] = negative
    return client.post(ENDPOINT, json=payload)


# ---------- fixtures ฝั่ง AI ----------

@pytest.fixture
def generator(ai_main):
    import services.generator as g
    return g


@pytest.fixture
def ai_client(ai_main):
    with TestClient(ai_main.app, raise_server_exceptions=False) as c:
        yield c


class FakeForgeResponse:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self._body


@pytest.fixture
def forge(monkeypatch):
    """Forge จำลอง: จดทุกครั้งที่ถูกเรียก แล้วตอบภาพ FORGE_PNG"""
    calls = []
    state = {"response": FakeForgeResponse(body={"images": [base64.b64encode(FORGE_PNG).decode()]})}

    def fake_post(url, json=None, timeout=None, **kw):
        calls.append({"url": url, "json": json, "timeout": timeout})
        if isinstance(state["response"], Exception):
            raise state["response"]
        return state["response"]

    monkeypatch.setattr(requests, "post", fake_post)
    return {"calls": calls, "state": state}


# ======================================================================
# ชั้น 1  frontend → backend
# ======================================================================

def test_1_requires_login(frontend):
    res = send_like_frontend(frontend)
    assert res.status_code == 401


def test_1_logged_in_user_gets_image(logged_in, ai_connected, forge):
    res = send_like_frontend(logged_in)

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("image/")


def test_1_empty_prompt_is_rejected_before_forge(logged_in, ai_connected, forge):
    res = send_like_frontend(logged_in, prompt="   ", negative="")

    assert res.status_code == 422, f"ได้ HTTP {res.status_code}"
    assert res.json()["error"]["code"] == "INVALID_PROMPT", (
        f"ได้รหัส {res.json()['error']['code']} — mainBackend.py ไม่ตรวจ prompt ว่างแล้ว "
        f"และ AI ก็ไม่ตรวจ จึงส่ง prompt ว่างไปให้ Forge (Forge ถูกเรียก {len(forge['calls'])} ครั้ง)"
    )


# ======================================================================
# ชั้น 2  backend → AI → generator.py
# ======================================================================

def test_2_backend_forwards_prompt_to_forge(logged_in, ai_connected, forge):
    send_like_frontend(logged_in, prompt="a cat on the moon")

    assert len(forge["calls"]) == 1, (
        "prompt ไปไม่ถึง generator.py"
    )


def test_2_frontend_receives_image_from_forge(logged_in, ai_connected, forge):
    res = send_like_frontend(logged_in)

    got = Image.open(io.BytesIO(res.content))
    assert res.content == FORGE_PNG, (
        f"ภาพที่ frontend ได้ไม่ใช่ภาพจาก Forge (ได้ {got.size[0]}x{got.size[1]})"
    )


def test_2_forge_off_gives_frontend_a_known_error(logged_in, ai_connected, forge):
    """Forge ปิด → หน้าเว็บควรได้รหัสที่รู้จัก (MODEL_UNAVAILABLE) และไม่เห็นที่อยู่ภายในระบบ"""
    forge["state"]["response"] = requests.ConnectionError("refused")
    res = send_like_frontend(logged_in)
    e = res.json()["error"]

    assert res.status_code == 503
    assert e["code"] == "MODEL_UNAVAILABLE", (
        f"ได้รหัส {e['code']} ซึ่งหน้าเว็บไม่มีข้อความรองรับ "
        f"ผู้ใช้จะเห็นข้อความดิบ: {e['message'][:90]}"
    )
    assert "http://" not in e["message"], "ข้อความ error เปิดเผย URL ภายในของ Forge ให้ผู้ใช้เห็น"


# ======================================================================
# ชั้น 3  AI endpoint /generate
# ======================================================================

def test_3_ai_accepts_frontend_payload(ai_client, forge):
    res = ai_client.post("/generate", json={"prompt": "a cat", "negative_prompt": "blurry"})

    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "image/png"
    assert res.content == FORGE_PNG


def test_3_ai_works_without_negative_prompt(ai_client, forge):
    """frontend ไม่ส่ง negative_prompt ถ้าช่องว่าง"""
    res = ai_client.post("/generate", json={"prompt": "a cat"})

    assert res.status_code == 200, res.text
    assert forge["calls"][0]["json"]["negative_prompt"] == ""
    assert forge["calls"][0]["json"]["seed"] == -1


def test_3_ai_returns_503_when_forge_is_off(ai_client, forge):
    forge["state"]["response"] = requests.ConnectionError("refused")
    res = ai_client.post("/generate", json={"prompt": "a cat"})

    assert res.status_code == 503
    assert "Forge" in res.json()["detail"]


def test_3_ai_returns_503_when_forge_errors(ai_client, forge):
    forge["state"]["response"] = FakeForgeResponse(status=500, text="CUDA out of memory")
    res = ai_client.post("/generate", json={"prompt": "a cat"})

    assert res.status_code == 503
    assert "500" in res.json()["detail"]


def test_3_ai_handles_forge_reply_without_image(ai_client, forge):
    """Forge ตอบ 200 แต่ไม่มีภาพ → ควรได้ error ที่อ่านออก ไม่ใช่ 500 ดิบ"""
    forge["state"]["response"] = FakeForgeResponse(body={"images": []})
    res = ai_client.post("/generate", json={"prompt": "a cat"})

    assert res.status_code == 503, (
        f"ได้ HTTP {res.status_code} — generator.py อ่าน result['images'][0] โดยไม่ตรวจ "
        "IndexError/KeyError หลุดออกมาเป็น 500"
    )


# ======================================================================
# ชั้น 4  generator.py → Forge
# ======================================================================

def test_4_generator_calls_forge_txt2img(generator, forge):
    out = generator.generate_image("a cat", "blurry", 42)

    call = forge["calls"][0]
    assert call["url"].endswith("/sdapi/v1/txt2img")
    assert call["json"] == {"prompt": "a cat", "negative_prompt": "blurry", "seed": 42} or \
        {"prompt", "negative_prompt", "seed"} <= call["json"].keys()
    assert out == FORGE_PNG          # ถอด base64 กลับเป็นไฟล์ภาพถูกต้อง


# ======================================================================
# ชั้น 5  สัญญาที่ตกลงกันไว้
# ======================================================================

def test_5_generator_requests_512x768_image(generator, forge):
    """Note.txt: 'output เป็นภาพ ขนาด 512x768 : 2ต่อ3'"""
    generator.generate_image("a cat")

    sent = forge["calls"][0]["json"]
    assert (sent.get("width"), sent.get("height")) == (512, 768), (
        f"generator.py ไม่ได้ส่ง width/height ไปที่ Forge (ส่งแค่ {sorted(sent)}) — "
        "Forge จะใช้ขนาดค่าตั้งต้นของมัน (ปกติ 512x512) ไม่ใช่ 512x768"
    )


def test_5_frontend_waits_as_long_as_ai(generator, forge):
    """frontend ต้องรอได้นานเท่ากับที่ AI รอ Forge ไม่งั้นหน้าเว็บตัดก่อนภาพเสร็จ"""
    generator.generate_image("a cat")
    ai_timeout_s = forge["calls"][0]["timeout"]

    config_js = (ROOT / "Image_index" / "js" / "config.js").read_text(encoding="utf-8")
    m = re.search(r"const PROCESS_TIMEOUT\s*=\s*(\d+)", config_js)
    assert m, "ไม่พบ PROCESS_TIMEOUT ใน config.js"
    frontend_timeout_s = int(m.group(1)) / 1000

    assert frontend_timeout_s >= ai_timeout_s, (
        f"หน้าเว็บรอแค่ {frontend_timeout_s:.0f} วินาที แต่ AI รอ Forge ได้ถึง {ai_timeout_s} วินาที — "
        "ถ้า Forge ใช้เวลาเกิน 2 นาที ผู้ใช้จะเห็น TIMEOUT ทั้งที่ภาพกำลังจะเสร็จ"
    )
