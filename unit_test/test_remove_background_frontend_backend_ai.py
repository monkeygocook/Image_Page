"""
ทดสอบ: frontend เรียกลบพื้นหลัง (AI_server/services/background.py) ผ่าน backend ได้ไหม

เส้นทาง
    api.js  POST /api/v1/remove-background  (multipart: image, output, refine_edge + Bearer token)
      → proxy.py → backend/mainBackend.py → AI_server/mainAI.py /remove-background
      → services/background.py remove_background()  (rembg)

ชั้น 1  frontend → backend      (ล็อกอิน, ตรวจไฟล์)
ชั้น 2  backend  → AI           (ส่งต่อจริงไหม, ผลกลับถึงหน้าเว็บไหม)
ชั้น 3  AI endpoint              (รับตัวเลือกจากหน้าเว็บไหม)
ชั้น 4  background.py + โมเดลจริง (หนัก รันแยกโปรเซส)

ชั้น 1–3 ใช้ตัวจำลอง (spy) แทนโมเดล เพื่อทดสอบเฉพาะการเชื่อมต่อ
"""
import io
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
AI_DIR = ROOT / "AI_server"
ENDPOINT = "/api/v1/remove-background"


def make_test_png() -> bytes:
    img = Image.new("RGB", (320, 320), (255, 255, 255))
    ImageDraw.Draw(img).ellipse([80, 60, 240, 280], fill=(200, 40, 40))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_transparent_png() -> bytes:
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    img.putpixel((0, 0), (123, 45, 210, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


AI_RESULT = make_transparent_png()


def send_like_frontend(client, output="transparent", refine_edge=True, file=None):
    name, data, mime = file or ("photo.png", make_test_png(), "image/png")
    return client.post(ENDPOINT, files={"image": (name, data, mime)},
                       data={"output": output, "refine_edge": str(refine_edge).lower()})


@pytest.fixture
def ai_spy(ai_connected, monkeypatch):
    """แทน remove_background ใน mainAI.py ด้วยตัวจำลองที่จดการเรียก"""
    calls = []

    def fake_remove_background(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return AI_RESULT

    monkeypatch.setattr(ai_connected, "remove_background", fake_remove_background)
    return calls


# ======================================================================
# ชั้น 1  frontend → backend
# ======================================================================

def test_1_requires_login(frontend):
    res = send_like_frontend(frontend)
    assert res.status_code == 401


def test_1_logged_in_user_gets_image(logged_in, ai_spy):
    res = send_like_frontend(logged_in)

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("image/png")


def test_1_backend_rejects_non_image_before_ai(logged_in, ai_spy):
    """API_SPEC + AI note.txt: backend ต้องตรวจชนิดไฟล์เองก่อนส่งให้ AI"""
    res = send_like_frontend(logged_in, file=("notes.txt", b"hello", "text/plain"))

    assert res.status_code == 415, (
        f"ได้ HTTP {res.status_code} — mainBackend.py ส่งไฟล์ .txt ต่อให้ AI ทั้งก้อน "
        f"(AI ถูกเรียก {len(ai_spy)} ครั้ง) ไม่ได้ตรวจชนิดไฟล์เหมือน fake.py เดิม"
    )
    assert len(ai_spy) == 0


def test_1_backend_enforces_12mb_limit(logged_in, ai_spy):
    """config.js บอกผู้ใช้ว่า 'ไม่เกิน 12 MB'"""
    big = b"\x89PNG" + b"0" * (13 * 1024 * 1024)
    res = send_like_frontend(logged_in, file=("big.png", big, "image/png"))

    assert res.status_code == 413, (
        f"ได้ HTTP {res.status_code} — mainBackend.py จำกัดแค่ 25 MB รวมทั้ง request "
        "ไฟล์ 13 MB จึงหลุดไปถึง AI"
    )


def test_1_ai_down_gives_clear_error(logged_in):
    """เครื่อง AI ปิด (fixture เริ่มต้นต่อ AI ไม่ติด)"""
    res = send_like_frontend(logged_in)

    assert res.status_code in (502, 503)
    assert res.json()["error"]["code"] in ("AI_DOWN", "MODEL_UNAVAILABLE")


# ======================================================================
# ชั้น 2  backend → AI
# ======================================================================

def test_2_backend_forwards_request_to_ai_server(logged_in, ai_spy):
    send_like_frontend(logged_in)
    assert len(ai_spy) == 1, "backend ไม่ได้เรียก AI_server"


def test_2_frontend_receives_image_produced_by_ai(logged_in, ai_spy):
    res = send_like_frontend(logged_in)
    assert res.content == AI_RESULT, "ภาพที่ frontend ได้ไม่ใช่ผลจาก AI"


# ======================================================================
# ชั้น 3  AI endpoint
# ======================================================================

def test_3_ai_receives_output_and_refine_edge_options(logged_in, ai_spy):
    """หน้าเว็บมีตัวเลือก โปร่งใส/พื้นขาว/พื้นดำ และ เกลาขอบ"""
    send_like_frontend(logged_in, output="white", refine_edge=False)

    assert ai_spy, "AI ไม่ได้เรียก remove_background เลย"
    call = ai_spy[0]
    passed = [a for a in call["args"] if not isinstance(a, bytes)] + list(call["kwargs"].values())
    assert "white" in map(str, passed), (
        "mainAI.py รับแค่ image แล้วเรียก remove_background(image_bytes) — "
        "ค่า output / refine_edge จากหน้าเว็บถูกทิ้ง เลือก 'พื้นขาว' ก็ได้พื้นโปร่งใส"
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
    pytest.importorskip("rembg", reason="ยังไม่ได้ติดตั้ง rembg")
    try:
        p = subprocess.run([sys.executable, "-c", _REAL_MODEL_SCRIPT], cwd=AI_DIR,
                           input=make_test_png(), capture_output=True, timeout=900)
    except subprocess.TimeoutExpired:
        pytest.fail("background.py ทำงานเกิน 15 นาที")

    out = p.stdout.decode(errors="replace").strip()
    err = p.stderr.decode(errors="replace")[-800:]
    if p.returncode in (-9, 137, 3221225477):
        pytest.fail("โปรเซสของ background.py โดน kill (น่าจะหน่วยความจำไม่พอ) — "
                    "rembg รุ่นใหม่ใช้โมเดล bria-rmbg (~1 GB) เป็นค่าเริ่มต้น\n" + err)
    assert p.returncode == 0, f"background.py error (exit {p.returncode}):\n{err}"

    info = dict(kv.split("=") for kv in out.split())
    assert info["mode"] == "RGBA", f"ผลลัพธ์ไม่มีช่องโปร่งใส: {out}"
    assert int(info["corner_alpha"]) < 30, f"พื้นหลังไม่ถูกลบ: {out}"
    assert int(info["center_alpha"]) > 200, f"วัตถุหลักหายไปด้วย: {out}"
