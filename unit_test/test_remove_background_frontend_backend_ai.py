"""
ทดสอบ: frontend เรียกฟังก์ชันลบพื้นหลัง (AI_server/services/background.py) ผ่าน backend ได้ไหม

เส้นทางที่ควรเป็น
    เบราว์เซอร์ (api.js)  POST /api/v1/remove-background  (multipart: image, output, refine_edge)
        → proxy.py (frontend)
        → backend/fake.py
        → AI_server/main.py   POST /remove-background
        → services/background.py  remove_background()  (rembg)

แบ่ง test เป็นชั้น เพื่อให้รู้ว่าพังที่ช่วงไหน
    ชั้น 1  frontend → backend           ส่งรูปถึง backend ไหม
    ชั้น 2  backend  → AI                backend ส่งต่อให้ AI ไหม
    ชั้น 3  AI endpoint (main.py)        รับฟอร์มแบบที่ frontend ส่งได้ไหม
    ชั้น 4  background.py + โมเดลจริง      ลบพื้นหลังได้จริงไหม (หนัก รันแยกโปรเซส)

ชั้น 1–3 แทนโมเดลจริงด้วยตัวจำลอง (spy) เพื่อให้เร็วและทดสอบเฉพาะ "การเชื่อมต่อ"
รัน (จากโฟลเดอร์ Image_Page):   pytest unit_test/test_remove_background_frontend_backend_ai.py -v
"""
import io
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
AI_DIR = ROOT / "AI_server"
ENDPOINT = "/api/v1/remove-background"


# ---------- ตัวช่วย ----------

def make_test_png() -> bytes:
    """รูปทดสอบ: วงกลมสีแดงบนพื้นขาว"""
    img = Image.new("RGB", (320, 320), (255, 255, 255))
    ImageDraw.Draw(img).ellipse([80, 60, 240, 280], fill=(200, 40, 40))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_transparent_png() -> bytes:
    """ผลลัพธ์จำลองจาก AI: PNG โปร่งใสที่มีลายเซ็นเฉพาะ (มุมซ้ายบนเป็นสีม่วง)"""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    img.putpixel((0, 0), (123, 45, 210, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


AI_RESULT = make_transparent_png()


def send_like_frontend(client, output="transparent", refine_edge=True):
    """ส่ง multipart แบบเดียวกับ api.js process(): fd.append("image", file) + options"""
    return client.post(
        ENDPOINT,
        files={"image": ("photo.png", make_test_png(), "image/png")},
        data={"output": output, "refine_edge": str(refine_edge).lower()},
    )


# ---------- fixtures ฝั่ง AI ----------

@pytest.fixture
def ai_main():
    """import AI_server/main.py (ต้องมีไลบรารีของ AI ติดตั้งอยู่)"""
    for lib in ("rembg", "cv2", "numpy", "multipart"):
        pytest.importorskip(lib, reason=f"ยังไม่ได้ติดตั้ง {lib} (ดู AI_server/requirements.txt)")
    if str(AI_DIR) not in sys.path:
        sys.path.insert(0, str(AI_DIR))
    import main
    return main


@pytest.fixture
def ai_spy(ai_main, monkeypatch):
    """แทน remove_background ใน main.py ด้วยตัวจำลองที่จดว่าถูกเรียกกี่ครั้ง/ด้วยอะไร"""
    calls = []

    def fake_remove_background(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return AI_RESULT

    monkeypatch.setattr(ai_main, "remove_background", fake_remove_background)
    return calls


@pytest.fixture
def ai_client(ai_main):
    with TestClient(ai_main.app) as c:
        yield c


# ======================================================================
# ชั้น 1  frontend → backend
# ======================================================================

def test_1_frontend_can_send_image_to_backend(frontend):
    res = send_like_frontend(frontend)

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("image/png")


def test_1_backend_rejects_non_image_file(frontend):
    res = frontend.post(ENDPOINT, files={"image": ("a.txt", b"hello", "text/plain")})

    assert res.status_code == 415
    assert res.json()["error"]["code"] == "UNSUPPORTED_TYPE"


# ======================================================================
# ชั้น 2  backend → AI
# ======================================================================

def test_2_backend_forwards_request_to_ai_server(frontend, ai_spy):
    send_like_frontend(frontend)

    assert len(ai_spy) == 1, (
        "backend ไม่ได้เรียก AI_server เลย — "
        "/api/v1/remove-background ใน backend/fake.py ตอบภาพ placeholder จาก render() กลับไปเอง"
    )


def test_2_frontend_receives_image_produced_by_ai(frontend, ai_spy):
    res = send_like_frontend(frontend)

    assert res.content == AI_RESULT, (
        "ภาพที่ frontend ได้รับไม่ใช่ผลจาก AI "
        f"(ได้ภาพ {Image.open(io.BytesIO(res.content)).size} โหมด "
        f"{Image.open(io.BytesIO(res.content)).mode} ซึ่งเป็นภาพตัวอักษร REMOVE-BG ของ fake.py)"
    )


# ======================================================================
# ชั้น 3  AI endpoint (main.py)
# ======================================================================

def test_3_ai_endpoint_accepts_frontend_form(ai_client, ai_spy):
    res = ai_client.post(
        "/remove-background",
        files={"image": ("photo.png", make_test_png(), "image/png")},
        data={"output": "transparent", "refine_edge": "true"},
    )

    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "image/png"
    assert res.content == AI_RESULT
    assert len(ai_spy) == 1


def test_3_ai_receives_output_and_refine_edge_options(ai_client, ai_spy):
    """หน้าเว็บมีตัวเลือก โปร่งใส/พื้นขาว/พื้นดำ และ เกลาขอบ — AI ต้องได้ค่าพวกนี้ไปด้วย"""
    ai_client.post(
        "/remove-background",
        files={"image": ("photo.png", make_test_png(), "image/png")},
        data={"output": "white", "refine_edge": "false"},
    )

    assert ai_spy, "AI ไม่ได้เรียก remove_background เลย"
    call = ai_spy[0]
    passed = [a for a in call["args"] if not isinstance(a, bytes)] + list(call["kwargs"].values())
    assert "white" in map(str, passed), (
        "main.py รับแค่ image แล้วเรียก remove_background(image_bytes) — "
        "ค่า output / refine_edge จากหน้าเว็บถูกทิ้ง เลือก 'พื้นขาว' ก็จะได้พื้นโปร่งใสเหมือนเดิม"
    )


# ======================================================================
# ชั้น 4  background.py + โมเดลจริง (หนัก)
# ======================================================================

_REAL_MODEL_SCRIPT = r"""
import io, sys
from PIL import Image
sys.path.insert(0, ".")
from services.background import remove_background
import rembg
data = sys.stdin.buffer.read()
out = Image.open(io.BytesIO(remove_background(data)))
alpha = out.getchannel("A") if "A" in out.getbands() else None
corner = alpha.getpixel((5, 5)) if alpha else 255
center = alpha.getpixel((160, 170)) if alpha else 255
print(f"rembg={rembg.__version__} mode={out.mode} corner_alpha={corner} center_alpha={center}")
"""


@pytest.mark.model
def test_4_real_background_py_removes_background():
    """
    เรียก background.py ของจริง (โหลดโมเดล rembg) ในโปรเซสแยก
    ถ้าเครื่องแรมไม่พอ โปรเซสจะโดน kill แต่ pytest ยังรายงานผลได้
    ครั้งแรกจะดาวน์โหลดโมเดล อาจใช้เวลาหลายนาที
    """
    pytest.importorskip("rembg", reason="ยังไม่ได้ติดตั้ง rembg")
    try:
        p = subprocess.run(
            [sys.executable, "-c", _REAL_MODEL_SCRIPT],
            cwd=AI_DIR, input=make_test_png(), capture_output=True, timeout=900,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("background.py ทำงานเกิน 15 นาที")

    out = p.stdout.decode(errors="replace").strip()
    err = p.stderr.decode(errors="replace")[-800:]
    if p.returncode in (-9, 137, 3221225477):
        pytest.fail(
            "โปรเซสของ background.py โดน kill (น่าจะหน่วยความจำไม่พอ) — "
            "rembg รุ่นใหม่ใช้โมเดล bria-rmbg (~1 GB) เป็นค่าเริ่มต้น\n" + err
        )
    assert p.returncode == 0, f"background.py error (exit {p.returncode}):\n{err}"

    info = dict(kv.split("=") for kv in out.split())
    assert info["mode"] == "RGBA", f"ผลลัพธ์ไม่มีช่องโปร่งใส: {out}"
    assert int(info["corner_alpha"]) < 30, f"พื้นหลังไม่ถูกลบ: {out}"
    assert int(info["center_alpha"]) > 200, f"วัตถุหลักหายไปด้วย: {out}"
