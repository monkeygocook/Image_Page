"""
ทดสอบ: ตัวเลือกของการสร้างภาพ — LoRA และขนาดภาพ

- ค่าที่หน้าเว็บ (config.js) มีให้เลือก ต้องตรงกับที่ backend และ AI รองรับ
- LoRA ที่เลือกต้องถูกต่อท้าย prompt ที่ส่งไป Forge จริง
- ขนาดที่เลือกต้องเป็น width/height ที่ส่งไป Forge
- ค่าที่ไม่รองรับต้องถูกปฏิเสธ และไม่ไปถึง Forge
"""
import base64
import io
import re
from pathlib import Path

import pytest
import requests
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "/api/v1/generate"


def _png():
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (5, 5, 5)).save(buf, "PNG")
    return buf.getvalue()


class _Reply:
    status_code = 200
    text = ""
    def raise_for_status(self): pass
    def json(self): return {"images": [base64.b64encode(_png()).decode()]}


@pytest.fixture
def forge(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None, **kw):
        calls.append(json)
        return _Reply()

    monkeypatch.setattr(requests, "post", fake_post)
    return calls


@pytest.fixture
def gen(ai_main):
    import services.generator as g
    return g


def frontend_values(field: str) -> list[str]:
    """อ่านค่า { v: "..." } ของ field ในแท็บ genimage จาก config.js"""
    src = (ROOT / "Image_index" / "js" / "config.js").read_text(encoding="utf-8")
    block = src[src.index("genimage: {"):]
    block = block[block.index(f"{field}: {{"):]
    block = block[:block.index("],")]
    return re.findall(r'v:\s*"([^"]+)"', block)


# ---------------------------------------------------------------- สัญญาระหว่าง 3 ฝั่ง

def test_frontend_lora_choices_match_ai(gen):
    choices = frontend_values("lora")
    assert "none" in choices
    assert set(choices) - {"none"} == set(gen.LORAS), (
        f"config.js มี {sorted(choices)} แต่ generator.py LORAS มี {sorted(gen.LORAS)}"
    )


def test_frontend_size_choices_match_ai(gen):
    choices = frontend_values("size")
    assert set(choices) == set(gen.IMAGE_SIZES), (
        f"config.js มี {sorted(choices)} แต่ generator.py IMAGE_SIZES มี {sorted(gen.IMAGE_SIZES)}"
    )
    assert gen.DEFAULT_SIZE in choices


@pytest.mark.parametrize("lora", ["none", "pixel_art", "linear_manga", "outline"])
def test_backend_accepts_every_frontend_lora(logged_in, ai_connected, forge, lora):
    r = logged_in.post(ENDPOINT, json={"prompt": "a house", "lora": lora})
    assert r.status_code == 200, f"lora={lora}: {r.text}"


# ---------------------------------------------------------------- LoRA ไปถึง Forge

def test_lora_tag_is_added_to_forge_prompt(logged_in, ai_connected, forge, gen):
    logged_in.post(ENDPOINT, json={"prompt": "a castle", "lora": "pixel_art"})
    sent = forge[0]["prompt"]
    f = gen.LORAS["pixel_art"]
    assert sent.startswith("a castle")
    assert f"<lora:{f['file']}:{f['weight']}>" in sent, sent


def test_lora_trigger_words_are_added(logged_in, ai_connected, forge, gen):
    logged_in.post(ENDPOINT, json={"prompt": "a girl", "lora": "linear_manga"})
    sent = forge[0]["prompt"]
    assert gen.LORAS["linear_manga"]["trigger"] in sent, sent
    assert "<lora:" in sent


def test_no_lora_keeps_prompt_unchanged(logged_in, ai_connected, forge):
    logged_in.post(ENDPOINT, json={"prompt": "plain prompt", "lora": "none"})
    logged_in.post(ENDPOINT, json={"prompt": "no field"})
    assert forge[0]["prompt"] == "plain prompt"
    assert forge[1]["prompt"] == "no field"


@pytest.mark.parametrize("bad", ["anime", "", 123, None, ["pixel_art"]])
def test_backend_rejects_unknown_lora_before_ai(logged_in, ai_connected, forge, bad):
    r = logged_in.post(ENDPOINT, json={"prompt": "x", "lora": bad})
    if bad is None:
        # null = ไม่ระบุ → backend ส่งต่อได้ หรือปฏิเสธก็ได้ แต่ต้องไม่ใส่ LoRA แปลก ๆ ไปที่ Forge
        assert r.status_code in (200, 422)
        if forge:
            assert "<lora:" not in forge[0]["prompt"]
        return
    assert r.status_code == 422, f"lora={bad!r} → {r.status_code}"
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert forge == [], "LoRA ที่ไม่รองรับหลุดไปถึง Forge"


def test_ai_rejects_unknown_lora(ai_main, forge):
    r = TestClient(ai_main.app).post("/generate", json={"prompt": "x", "lora": "anime"})
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "INVALID_LORA"
    assert forge == []


def test_build_lora_prompt_dedupes_and_rejects(gen):
    once = gen.build_lora_prompt("p", ["outline"])
    twice = gen.build_lora_prompt("p", ["outline", "outline"])
    assert once == twice, "ใส่ LoRA ซ้ำแล้วได้แท็กซ้ำ"
    with pytest.raises(ValueError):
        gen.build_lora_prompt("p", ["nope"])
    assert gen.build_lora_prompt("p", None) == "p"


# ---------------------------------------------------------------- ขนาดภาพไปถึง Forge

@pytest.mark.parametrize("size", ["512x512", "512x768", "768x512", "768x768"])
def test_size_becomes_forge_width_height(logged_in, ai_connected, forge, size):
    r = logged_in.post(ENDPOINT, json={"prompt": "x", "size": size})
    assert r.status_code == 200, r.text
    w, h = map(int, size.split("x"))
    assert (forge[0]["width"], forge[0]["height"]) == (w, h)


def test_default_size_when_not_sent(logged_in, ai_connected, forge, gen):
    logged_in.post(ENDPOINT, json={"prompt": "x"})
    assert (forge[0]["width"], forge[0]["height"]) == gen.IMAGE_SIZES[gen.DEFAULT_SIZE]


@pytest.mark.parametrize("bad", ["1024x1024", "512*768", "big"])
def test_unsupported_size_never_reaches_forge(logged_in, ai_connected, forge, bad):
    r = logged_in.post(ENDPOINT, json={"prompt": "x", "size": bad})
    assert r.status_code >= 400, f"size={bad} → {r.status_code}"
    assert forge == [], "ขนาดที่ไม่รองรับหลุดไปถึง Forge"


def test_ai_rejects_unknown_size(ai_main, forge):
    r = TestClient(ai_main.app).post("/generate", json={"prompt": "x", "size": "1024x1024"})
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "INVALID_SIZE"


def test_unsupported_size_message_is_not_about_prompt(logged_in, ai_connected, forge):
    """ผู้ใช้ส่งขนาดผิด ไม่ควรเห็นข้อความว่า 'Prompt ไม่ถูกต้อง'"""
    r = logged_in.post(ENDPOINT, json={"prompt": "a valid prompt", "size": "1024x1024"})
    code = r.json()["error"]["code"]
    assert code != "INVALID_PROMPT", (
        "ส่งขนาดภาพผิด แต่ผู้ใช้ได้รหัส INVALID_PROMPT ('ข้อมูล Prompt ไม่ถูกต้อง') — "
        "backend แปลง 422 ทุกแบบจาก /generate เป็น INVALID_PROMPT (AI_ERR_OVERRIDE) "
        "และ backend ไม่ตรวจ size เองเหมือนที่ตรวจ lora"
    )
