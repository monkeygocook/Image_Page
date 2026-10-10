"""
ปรับค่าภาพพื้นฐาน (Adjust) ทีละค่า ผู้ใช้เลื่อนสไลเดอร์ปรับได้หลายค่าพร้อมกัน

ทุกค่ามีช่วง -100..+100 และ 0 = ไม่เปลี่ยนแปลง

    brightness  : ความสว่าง          (+ สว่างขึ้น   / - มืดลง)
    contrast    : คอนทราสต์          (+ คมชัดจัด    / - จืดซีด)
    saturation  : ความอิ่มตัวของสี   (+ สีจัดขึ้น   / - สีจางลงจนเป็นขาว-ดำ)
    temperature : อุณหภูมิสี         (+ อุ่น ส้ม     / - เย็น ฟ้า)
    vignette    : ขอบภาพ             (+ ขอบมืด      / - ขอบสว่าง)

ลำดับการทำงาน
-------------
temperature -> saturation -> contrast -> brightness -> vignette
(แต่ละขั้นรับผลจากขั้นก่อนหน้า และตัดค่าให้อยู่ในช่วง 0-255 ตอนท้าย)
"""
from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image

SLIDER_MIN = -100
SLIDER_MAX = 100


# ---------------------------------------------------------------------------
# ฟังก์ชันช่วย
# ---------------------------------------------------------------------------

def _load_image(image_bytes: bytes) -> np.ndarray:
    """แปลงไฟล์รูป (bytes) เป็นอาร์เรย์ float32 shape (สูง, กว้าง, 3) ลำดับสี R,G,B"""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise ValueError("Invalid or corrupted image file") from exc
    return np.array(image.convert("RGB")).astype(np.float32)


def _encode_png(rgb: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# ตัวปรับแต่ละค่า (รับ/คืน float32 ค่าสี 0-255 โดย value คือค่าสไลเดอร์ -100..100)
# ---------------------------------------------------------------------------

def _temperature(rgb: np.ndarray, value: int) -> np.ndarray:
    """อุณหภูมิสี: ดันแดงกับน้ำเงินสวนทางกัน"""
    k = value / 100.0
    out = rgb.copy()
    out[..., 0] *= 1 + 0.2 * k  # แดง: + อุ่นขึ้น
    out[..., 2] *= 1 - 0.2 * k  # น้ำเงิน: + ลดลง (จึงอุ่น)
    return out


def _saturation(rgb: np.ndarray, value: int) -> np.ndarray:
    """ความอิ่มตัว: ผสมระหว่างภาพเทากับภาพสีเดิม"""
    gray = cv2.cvtColor(np.clip(rgb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    gray = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB).astype(np.float32)
    factor = 1 + value / 100.0  # -100 -> 0 (ขาวดำ), 0 -> 1 (เดิม), 100 -> 2 (จัด 2 เท่า)
    return gray + factor * (rgb - gray)


def _contrast(rgb: np.ndarray, value: int) -> np.ndarray:
    """คอนทราสต์: ดึงค่าสีออก/เข้าหาเทากลาง 128"""
    factor = 1 + value / 100.0  # -100 -> 0 (เทาล้วน), 0 -> 1 (เดิม), 100 -> 2
    return (rgb - 128) * factor + 128


def _brightness(rgb: np.ndarray, value: int) -> np.ndarray:
    """ความสว่าง: บวก/ลบค่าสีทุกพิกเซลเท่ากัน (สูงสุด +/-100 จาก 255)"""
    return rgb + value * 1.0


def _vignette(rgb: np.ndarray, value: int) -> np.ndarray:
    """ขอบภาพ: ยิ่งไกลจากกลางภาพยิ่งมืด (ค่าบวก) หรือสว่าง (ค่าลบ)"""
    h, w = rgb.shape[:2]
    y, x = np.ogrid[:h, :w]
    # ระยะจากกึ่งกลางรูป: 0 ที่กลาง, ประมาณ 1 ที่ขอบ, เกิน 1 ที่มุม
    dist = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2)
    weight = np.clip(dist, 0, 1) ** 2  # ตรงกลางไม่โดนผล เพิ่มขึ้นเรื่อยๆ ไปทางขอบ
    gain = 1 - 0.6 * (value / 100.0) * weight  # +100 -> ขอบมืดลง 60%, -100 -> ขอบสว่างขึ้น 60%
    return rgb * gain[..., None]


# ลำดับในตารางนี้คือลำดับที่ใช้ปรับจริง
ADJUSTMENTS = {
    "temperature": _temperature,
    "saturation": _saturation,
    "contrast": _contrast,
    "brightness": _brightness,
    "vignette": _vignette,
}


# ---------------------------------------------------------------------------
# ฟังก์ชันหลัก (main.py เรียกใช้ตัวนี้)
# ---------------------------------------------------------------------------

def adjust_image(
    image_bytes: bytes,
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
    temperature: int = 0,
    vignette: int = 0,
) -> bytes:
    """ปรับค่าภาพหลายค่าพร้อมกัน แล้วคืนค่าเป็นไฟล์ PNG (bytes)

    ทุกค่ามีช่วง -100..100 (0 = ไม่เปลี่ยน)
    """
    values = {
        "brightness": brightness,
        "contrast": contrast,
        "saturation": saturation,
        "temperature": temperature,
        "vignette": vignette,
    }
    for name, value in values.items():
        if not SLIDER_MIN <= value <= SLIDER_MAX:
            raise ValueError(f"{name} must be between {SLIDER_MIN} and {SLIDER_MAX}")

    rgb = _load_image(image_bytes)

    for name, func in ADJUSTMENTS.items():
        if values[name] != 0:  # ข้ามค่าที่เป็น 0 เพื่อไม่ให้รูปเปลี่ยนโดยไม่จำเป็น
            rgb = func(rgb, values[name])

    return _encode_png(np.clip(rgb, 0, 255).astype(np.uint8))
