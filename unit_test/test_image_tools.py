"""
ทดสอบ: เครื่องมือแต่งภาพ 3 ตัว  —  Adjust / Filter / Blur

เส้นทาง
    api.js  POST /api/v1/{adjust|filter|blur}  (multipart: image + ตัวเลือก)
      → proxy.py → backend/mainBackend.py → AI_server/mainAI.py /{adjust|filter|blur}
      → services/adjust.py · services/Filter.py · services/blur.py

ชั้น 1  frontend → backend → AI  (ตัวเลือกจากหน้าเว็บไปถึงฟังก์ชันครบไหม)  ใช้ spy แทนฟังก์ชันจริง
ชั้น 2  AI endpoint ตรวจค่าที่ผิด
ชั้น 3  ฟังก์ชันจริง (เร็ว ไม่ต้องโหลดโมเดล — ยกเว้น background blur ที่ใช้ rembg)
"""
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image


def png(size=(64, 48), color=(200, 100, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def pattern_png(size=(64, 48)) -> bytes:
    """ภาพลายทาง (มีขอบให้เบลอ/ปรับคอนทราสต์เห็นผล)"""
    w, h = size
    arr = np.zeros((h, w, 3), np.uint8)
    arr[:, ::4] = (240, 40, 40)
    arr[::6, :] = (30, 200, 90)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return buf.getvalue()


def pixels(data: bytes) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(data)).convert("RGB")).astype(int)


def roughness(arr: np.ndarray) -> float:
    """ความต่างของสีระหว่างพิกเซลข้างเคียง — ยิ่งเบลอยิ่งน้อย"""
    return float(np.abs(np.diff(arr, axis=1)).mean() + np.abs(np.diff(arr, axis=0)).mean())


RESULT = png((8, 8), (1, 2, 3))


def send(client, tool, fields, file=None):
    name, data, mime = file or ("photo.png", png(), "image/png")
    return client.post(f"/api/v1/{tool}", files={"image": (name, data, mime)},
                       data={k: str(v) for k, v in fields.items()})


@pytest.fixture
def spy(ai_connected, monkeypatch):
    """แทนฟังก์ชันใน mainAI.py ด้วยตัวจดการเรียก"""
    calls = []

    def make(tag):
        def fake(*args, **kwargs):
            calls.append({"tool": tag, "args": args, "kwargs": kwargs})
            return RESULT
        return fake

    monkeypatch.setattr(ai_connected, "adjust_image", make("adjust"))
    monkeypatch.setattr(ai_connected, "apply_filter", make("filter"))
    monkeypatch.setattr(ai_connected, "BLUR_HANDLERS",
                        {k: make(f"blur:{k}") for k in ai_connected.BLUR_HANDLERS})
    return calls


def passed_values(call):
    return [a for a in call["args"] if not isinstance(a, bytes)] + list(call["kwargs"].values())


# ======================================================================
# ชั้น 1  frontend → backend → AI
# ======================================================================

@pytest.mark.parametrize("tool", ["adjust", "filter", "blur"])
def test_1_requires_login(frontend, tool):
    assert send(frontend, tool, {}).status_code == 401


@pytest.mark.parametrize("tool", ["adjust", "filter", "blur"])
def test_1_backend_rejects_non_image(logged_in, spy, tool):
    res = send(logged_in, tool, {}, file=("notes.txt", b"hello", "text/plain"))
    assert res.status_code == 415, res.text
    assert spy == [], "ไฟล์ที่ไม่ใช่รูปหลุดไปถึง AI"


def test_1_adjust_sliders_reach_ai(logged_in, spy):
    res = send(logged_in, "adjust", {"brightness": 30, "contrast": -20, "saturation": 15,
                                     "temperature": -40, "vignette": 60})
    assert res.status_code == 200, res.text
    assert res.content == RESULT
    assert len(spy) == 1 and spy[0]["tool"] == "adjust"
    assert passed_values(spy[0]) == [30, -20, 15, -40, 60], (
        "ลำดับ/ค่าที่ส่งเข้า adjust_image ไม่ตรง brightness, contrast, saturation, temperature, vignette"
    )


def test_1_filter_name_and_intensity_reach_ai(logged_in, spy):
    res = send(logged_in, "filter", {"filter_name": "sepia", "intensity": 70})
    assert res.status_code == 200, res.text
    assert spy[0]["tool"] == "filter"
    assert passed_values(spy[0]) == ["sepia", 70]


@pytest.mark.parametrize("blur_type", ["gaussian", "background", "face"])
def test_1_blur_type_picks_right_function(logged_in, spy, blur_type):
    res = send(logged_in, "blur", {"blur_type": blur_type, "blur_amount": 55})
    assert res.status_code == 200, res.text
    assert spy[0]["tool"] == f"blur:{blur_type}"
    assert passed_values(spy[0]) == [55]


def test_1_defaults_when_frontend_sends_nothing(logged_in, spy):
    send(logged_in, "adjust", {})
    send(logged_in, "filter", {})
    send(logged_in, "blur", {})
    assert passed_values(spy[0]) == [0, 0, 0, 0, 0]
    assert passed_values(spy[1]) == ["grayscale", 100]
    assert spy[2]["tool"] == "blur:gaussian" and passed_values(spy[2]) == [40]


def test_1_bad_value_gives_frontend_an_error_not_an_image(logged_in, spy):
    res = send(logged_in, "filter", {"filter_name": "rainbow"})
    assert res.status_code >= 400
    assert "error" in res.json() and res.json()["error"]["code"]
    assert spy == []


# ======================================================================
# ชั้น 2  AI endpoint ตรวจค่า
# ======================================================================

@pytest.fixture
def ai(ai_main):
    return TestClient(ai_main.app)


def ai_send(ai, tool, fields, data=None):
    return ai.post(f"/{tool}", files={"image": ("p.png", data or png(), "image/png")},
                   data={k: str(v) for k, v in fields.items()})


@pytest.mark.parametrize("tool,fields,code", [
    ("filter", {"filter_name": "rainbow"}, "INVALID_FILTER"),
    ("filter", {"filter_name": "sepia", "intensity": 150}, "INVALID_INTENSITY"),
    ("filter", {"filter_name": "sepia", "intensity": -101}, "INVALID_INTENSITY"),
    ("blur", {"blur_type": "motion"}, "INVALID_BLUR_TYPE"),
    ("blur", {"blur_type": "gaussian", "blur_amount": 101}, "INVALID_BLUR_AMOUNT"),
    ("blur", {"blur_type": "gaussian", "blur_amount": -1}, "INVALID_BLUR_AMOUNT"),
    ("adjust", {"brightness": 150}, "INVALID_ADJUST_REQUEST"),
    ("adjust", {"vignette": -101}, "INVALID_ADJUST_REQUEST"),
])
def test_2_ai_rejects_out_of_range(ai, tool, fields, code):
    res = ai_send(ai, tool, fields)
    assert res.status_code == 422, res.text
    assert res.json()["detail"]["error"]["code"] == code


@pytest.mark.parametrize("tool,fields", [
    ("adjust", {"brightness": 10}),
    ("filter", {"filter_name": "sepia"}),
    ("blur", {"blur_type": "gaussian", "blur_amount": 30}),
])
def test_2_ai_rejects_broken_image(ai, tool, fields):
    res = ai_send(ai, tool, fields, data=b"\x89PNG not really a png")
    assert res.status_code == 422, res.text
    assert res.json()["detail"]["error"]["code"] in ("INVALID_IMAGE", "INVALID_ADJUST_REQUEST")


@pytest.mark.parametrize("tool,fields", [
    ("adjust", {"brightness": 20, "contrast": 10}),
    ("filter", {"filter_name": "cartoon", "intensity": 80}),
    ("blur", {"blur_type": "gaussian", "blur_amount": 50}),
])
def test_2_ai_returns_png_same_size(ai, tool, fields):
    res = ai_send(ai, tool, fields, data=pattern_png((64, 48)))
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(res.content)).size == (64, 48)


# ======================================================================
# ชั้น 3  ฟังก์ชันจริง
# ======================================================================

@pytest.fixture
def services(ai_main):
    from services import Filter, adjust, blur
    return {"adjust": adjust, "filter": Filter, "blur": blur}


# ---------- adjust.py ----------

def test_3_adjust_all_zero_keeps_image(services):
    src = pattern_png()
    assert (pixels(services["adjust"].adjust_image(src)) == pixels(src)).all()


def test_3_adjust_brightness_direction(services):
    src = png(color=(100, 100, 100))
    up = pixels(services["adjust"].adjust_image(src, brightness=50)).mean()
    down = pixels(services["adjust"].adjust_image(src, brightness=-50)).mean()
    assert down < 100 < up


def test_3_adjust_saturation_minus_100_is_gray(services):
    out = pixels(services["adjust"].adjust_image(png(color=(220, 60, 30)), saturation=-100))
    assert (out.max(axis=2) - out.min(axis=2)).max() <= 1, "saturation -100 ควรได้ภาพขาวดำ"


def test_3_adjust_temperature_warm_and_cool(services):
    src = png(color=(120, 120, 120))
    warm = pixels(services["adjust"].adjust_image(src, temperature=80))[0, 0]
    cool = pixels(services["adjust"].adjust_image(src, temperature=-80))[0, 0]
    assert warm[0] > warm[2], "อุ่น = แดงมากกว่าน้ำเงิน"
    assert cool[2] > cool[0], "เย็น = น้ำเงินมากกว่าแดง"


def test_3_adjust_vignette_darkens_corners_not_center(services):
    src = png((101, 101), (180, 180, 180))
    out = pixels(services["adjust"].adjust_image(src, vignette=100))
    assert out[0, 0].mean() < out[50, 50].mean()
    assert abs(out[50, 50].mean() - 180) <= 1


def test_3_adjust_keeps_transparent_png_readable(services):
    buf = io.BytesIO()
    Image.new("RGBA", (16, 16), (10, 20, 30, 0)).save(buf, "PNG")
    out = services["adjust"].adjust_image(buf.getvalue(), brightness=10)
    assert Image.open(io.BytesIO(out)).size == (16, 16)


def test_3_adjust_rejects_out_of_range_and_bad_bytes(services):
    with pytest.raises(ValueError):
        services["adjust"].adjust_image(png(), contrast=101)
    with pytest.raises(ValueError):
        services["adjust"].adjust_image(b"not an image", brightness=5)


# ---------- Filter.py ----------

def test_3_every_filter_returns_same_size(services):
    src = pattern_png((40, 30))
    for name in services["filter"].FILTERS:
        out = Image.open(io.BytesIO(services["filter"].apply_filter(src, name, 100)))
        assert out.size == (40, 30), name


def test_3_filter_intensity_zero_is_original(services):
    src = pattern_png()
    for name in services["filter"].FILTERS:
        assert (pixels(services["filter"].apply_filter(src, name, 0)) == pixels(src)).all(), name


def test_3_grayscale_full_is_gray(services):
    out = pixels(services["filter"].apply_filter(pattern_png(), "grayscale", 100))
    assert (out[..., 0] == out[..., 1]).all() and (out[..., 1] == out[..., 2]).all()


def test_3_filter_half_intensity_is_between(services):
    src = png(color=(200, 50, 50))
    full = pixels(services["filter"].apply_filter(src, "grayscale", 100))[0, 0]
    half = pixels(services["filter"].apply_filter(src, "grayscale", 50))[0, 0]
    orig = pixels(src)[0, 0]
    for c in range(3):
        lo, hi = sorted((orig[c], full[c]))
        assert lo - 1 <= half[c] <= hi + 1


def test_3_filter_rejects_bad_input(services):
    with pytest.raises(ValueError):
        services["filter"].apply_filter(png(), "rainbow")
    with pytest.raises(ValueError):
        services["filter"].apply_filter(png(), "sepia", 101)
    with pytest.raises(ValueError):
        services["filter"].apply_filter(b"junk", "sepia")


# ---------- blur.py ----------

def test_3_gaussian_blur_smooths_edges(services):
    src = pattern_png()
    out = pixels(services["blur"].gaussian_blur(src, 60))
    assert roughness(out) < roughness(pixels(src)) * 0.5, "เบลอแล้วขอบควรนุ่มลง"


def test_3_more_blur_is_smoother(services):
    src = pattern_png()
    light = roughness(pixels(services["blur"].gaussian_blur(src, 20)))
    heavy = roughness(pixels(services["blur"].gaussian_blur(src, 90)))
    assert heavy < light


def test_3_blur_amount_zero_returns_original(services):
    src = pattern_png()
    for fn in ("gaussian_blur", "face_blur", "background_blur"):
        assert getattr(services["blur"], fn)(src, 0) == src, fn


def test_3_face_blur_without_face_keeps_image(services):
    src = pattern_png()
    assert services["blur"].face_blur(src, 80) == src


def test_3_gaussian_blur_rejects_bad_bytes(services):
    with pytest.raises(ValueError):
        services["blur"].gaussian_blur(b"junk", 50)


def test_3_background_blur_keeps_subject_sharp(services, monkeypatch):
    """แทนโมเดล rembg ด้วย mask ตายตัว: ครึ่งซ้าย = วัตถุ (คมเหมือนเดิม) ครึ่งขวา = พื้นหลัง (เบลอ)"""
    def fake_mask(image):
        w, h = image.size
        m = Image.new("L", (w, h), 0)
        m.paste(255, (0, 0, w // 2, h))
        return m
    monkeypatch.setattr(services["blur"], "_foreground_mask", fake_mask)
    src = pattern_png((64, 48))
    out = pixels(services["blur"].background_blur(src, 80))
    orig = pixels(src)
    assert (out[:, :28] == orig[:, :28]).all(), "ฝั่งวัตถุถูกเบลอไปด้วย"
    assert roughness(out[:, 36:]) < roughness(orig[:, 36:]) * 0.5, "ฝั่งพื้นหลังไม่ถูกเบลอ"
