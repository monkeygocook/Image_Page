"""
สร้างฟิลเตอร์สำหรับประมวลผลภาพ ให้เข้ากลับจุดประสงค์การใช้ AI เป็นหลัก

ภาพรวมการทำงาน
--------------
1. รับรูปเข้ามาเป็น bytes (ไฟล์ที่อัปโหลดมา)
2. แปลงเป็นอาร์เรย์ตัวเลข (numpy) ที่เก็บค่าสี R, G, B ของแต่ละพิกเซล (0-255)
3. ส่งให้ฟังก์ชันฟิลเตอร์ที่เลือกคำนวณค่าสีใหม่
4. ปรับความแรงตามค่า intensity (-100..100) โดยเทียบกับรูปต้นฉบับ
5. แปลงกลับเป็น PNG (bytes) เพื่อส่งคืนให้ผู้ใช้

โครงสร้างไฟล์
-------------
- ฟังก์ชันช่วย:     _load_image, _encode_png, _clip
- ฟังก์ชันฟิลเตอร์: _grayscale, _sepia, ... (แต่ละตัวรับรูป RGB แล้วคืนรูป RGB)
- FILTERS:           ตารางจับคู่ "ชื่อฟิลเตอร์" -> "ฟังก์ชัน"
- apply_filter:      ฟังก์ชันหลักที่ main.py เรียกใช้
"""
from __future__ import annotations

import io

import cv2          # OpenCV: ไลบรารีประมวลผลภาพ (blur, แปลงสี, ตรวจขอบ ฯลฯ)
import numpy as np  # จัดการรูปเป็นอาร์เรย์ตัวเลข คำนวณทั้งรูปได้ในครั้งเดียว
from PIL import Image  # Pillow: ใช้เปิด/บันทึกไฟล์รูป

INTENSITY_MIN = -100
INTENSITY_MAX = 100


# ---------------------------------------------------------------------------
# ฟังก์ชันช่วย (helper)
# ---------------------------------------------------------------------------

def _load_image(image_bytes: bytes) -> np.ndarray:
    """แปลงไฟล์รูป (bytes) เป็นอาร์เรย์ shape (สูง, กว้าง, 3) ลำดับสี R,G,B"""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()  # บังคับอ่านไฟล์จริง เพื่อให้ไฟล์เสียแล้วเกิด error ตรงนี้
    except Exception as exc:
        raise ValueError("Invalid or corrupted image file") from exc
    # convert("RGB") ทำให้ทุกรูป (PNG โปร่งใส, ขาวดำ ฯลฯ) มี 3 ช่องสีเหมือนกันหมด
    return np.array(image.convert("RGB"))


def _encode_png(rgb: np.ndarray) -> bytes:
    """แปลงอาร์เรย์รูปกลับเป็นไฟล์ PNG (bytes) เพื่อส่งกลับไปให้ผู้ใช้"""
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return buffer.getvalue()


def _clip(arr: np.ndarray) -> np.ndarray:
    """จำกัดค่าสีให้อยู่ในช่วง 0-255 แล้วแปลงเป็นจำนวนเต็ม 8 บิต

    เวลาคูณสีเพิ่ม เช่น 200 * 1.3 = 260 ซึ่งเกิน 255 ต้องตัดให้เหลือ 255
    ไม่เช่นนั้นสีจะเพี้ยนกลับไปเป็นค่าต่ำ (ล้นจนวนกลับ)
    """
    return np.clip(arr, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# ฟังก์ชันฟิลเตอร์ (แต่ละตัวรับรูป RGB และคืนรูป RGB ขนาดเท่าเดิม)
# ---------------------------------------------------------------------------

def _grayscale(rgb: np.ndarray) -> np.ndarray:
    """ขาว-ดำ"""
    # แปลงเป็นภาพเทา (ช่องเดียว) ก่อน
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # แปลงกลับเป็น 3 ช่อง (R=G=B) เพื่อให้รูปแบบเหมือนฟิลเตอร์อื่น
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)


def _sepia(rgb: np.ndarray) -> np.ndarray:
    """โทนน้ำตาลเหลืองแบบรูปเก่า"""
    # แต่ละแถวคือสูตรคำนวณสีใหม่ของ R, G, B จากสีเดิมทั้ง 3 ช่อง
    # (ค่านี้เป็นสูตรมาตรฐานของ sepia)
    kernel = np.array([
        [0.393, 0.769, 0.189],  # R ใหม่ = 0.393*R + 0.769*G + 0.189*B
        [0.349, 0.686, 0.168],  # G ใหม่
        [0.272, 0.534, 0.131],  # B ใหม่
    ])
    # @ คือการคูณเมทริกซ์ ทำกับทุกพิกเซลพร้อมกัน; .T คือสลับแถว/คอลัมน์ให้ถูกทิศ
    return _clip(rgb.astype(np.float32) @ kernel.T)


def _warm(rgb: np.ndarray) -> np.ndarray:
    """โทนอุ่น (ส้ม/แดงขึ้น)"""
    out = rgb.astype(np.float32)  # ใช้ทศนิยมเพื่อให้คูณได้ละเอียด
    out[..., 0] *= 1.12  # ช่อง 0 = แดง เพิ่ม 12%
    out[..., 2] *= 0.9   # ช่อง 2 = น้ำเงิน ลด 10%
    return _clip(out)


def _cool(rgb: np.ndarray) -> np.ndarray:
    """โทนเย็น (ฟ้าขึ้น) ตรงข้ามกับ warm"""
    out = rgb.astype(np.float32)
    out[..., 0] *= 0.9   # ลดแดง
    out[..., 2] *= 1.12  # เพิ่มน้ำเงิน
    return _clip(out)


def _vivid(rgb: np.ndarray) -> np.ndarray:
    """สีสดขึ้น"""
    # HSV แยกภาพเป็น: H=เฉดสี, S=ความสด, V=ความสว่าง
    # จึงปรับความสดอย่างเดียวได้โดยไม่ทำให้เฉดสีเพี้ยน
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    hsv[..., 1] *= 1.4   # เพิ่มความสด (S) 40%
    hsv[..., 2] *= 1.05  # เพิ่มความสว่าง (V) เล็กน้อย
    return cv2.cvtColor(_clip(hsv), cv2.COLOR_HSV2RGB)


def _vintage(rgb: np.ndarray) -> np.ndarray:
    """แนววินเทจ: โทน sepia + คอนทราสต์ต่ำ + ขอบมืด"""
    out = _sepia(rgb).astype(np.float32)
    # ลดคอนทราสต์ (ดึงค่าเข้าหาเทากลาง 128) แล้วยกความสว่างขึ้น 10
    out = (out - 128) * 0.85 + 128 + 10

    h, w = out.shape[:2]
    y, x = np.ogrid[:h, :w]  # พิกัดแถวและคอลัมน์ของทุกพิกเซล
    # ระยะห่างจากกึ่งกลางรูป: 0 ที่กลางรูป, ประมาณ 1 ที่ขอบ
    dist = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2)
    # ยิ่งไกลจากกลางยิ่งมืด (มืดสุด 35%) ทำให้เกิดขอบดำจางๆ (vignette)
    vignette = 1 - 0.35 * np.clip(dist, 0, 1) ** 2
    return _clip(out * vignette[..., None])  # [..., None] เพิ่มมิติให้คูณได้ทั้ง 3 สี


def _cinematic(rgb: np.ndarray) -> np.ndarray:
    """โทนหนัง: ไฮไลต์ส้ม เงาฟ้า (teal & orange) คอนทราสต์สูง"""
    out = rgb.astype(np.float32) / 255.0  # ปรับค่าเป็นช่วง 0.0-1.0 เพื่อคำนวณง่าย
    out = out ** 1.1                       # gamma > 1 ทำให้ภาพโดยรวมเข้มขึ้นนิดหน่อย
    out[..., 0] = out[..., 0] * 1.08 + 0.02  # ดันแดง -> ส่วนสว่างออกโทนส้ม
    out[..., 2] = out[..., 2] * 1.05 + 0.03  # ดันน้ำเงิน -> ส่วนมืดออกโทนฟ้า
    out = (out - 0.5) * 1.15 + 0.5           # เพิ่มคอนทราสต์รอบค่ากลาง 0.5
    return _clip(out * 255)


def _sharpen(rgb: np.ndarray) -> np.ndarray:
    """เพิ่มความคมชัด (เทคนิค unsharp mask)"""
    # ทำรูปเบลอก่อน แล้วเอา "รูปเดิม x1.8 ลบ รูปเบลอ x0.8"
    # ส่วนที่ต่างจากรูปเบลอคือรายละเอียด/ขอบ จึงถูกเน้นให้เด่นขึ้น
    blurred = cv2.GaussianBlur(rgb, (0, 0), 2)  # (0,0) = ให้คำนวณขนาดจาก sigma=2
    return cv2.addWeighted(rgb, 1.8, blurred, -0.8, 0)


def _sketch(rgb: np.ndarray) -> np.ndarray:
    """ภาพวาดลายเส้นดินสอ"""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # กลับสีภาพเทา (ขาว<->ดำ) แล้วเบลอ
    inverted_blur = cv2.GaussianBlur(255 - gray, (21, 21), 0)
    # หารภาพเทาด้วยภาพกลับสีที่เบลอ (color dodge)
    # บริเวณเรียบจะกลายเป็นขาว เหลือแต่ขอบเป็นเส้นสีเข้ม เหมือนลายเส้นดินสอ
    sketch = cv2.divide(gray, 255 - inverted_blur, scale=256)
    return cv2.cvtColor(sketch, cv2.COLOR_GRAY2RGB)


def _cartoon(rgb: np.ndarray) -> np.ndarray:
    """ภาพการ์ตูน: สีเรียบเป็นปื้น + เส้นขอบดำ"""
    # 1) หาเส้นขอบ: ทำภาพเทาแล้วเบลอแบบ median เพื่อลดจุดรบกวน
    gray = cv2.medianBlur(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), 7)
    # ตรวจขอบแบบปรับตามบริเวณ: ได้ภาพขาว-ดำ โดยเส้นขอบเป็นสีดำ
    edges = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 9, 9
    )
    # 2) ทำให้สีเรียบ: bilateral filter เบลอพื้นที่สีเดียวกัน แต่รักษาขอบไว้
    color = cv2.bilateralFilter(rgb, 9, 150, 150)
    # 3) นำเส้นขอบมาทับสีเรียบ (ที่ขอบเป็นดำ ผลลัพธ์จึงเป็นเส้นดำ)
    return cv2.bitwise_and(color, color, mask=edges)


# ---------------------------------------------------------------------------
# ตารางฟิลเตอร์
# ---------------------------------------------------------------------------

# จับคู่ "ชื่อที่ผู้ใช้ส่งมา" กับ "ฟังก์ชันที่จะทำงาน"
# จะเพิ่มฟิลเตอร์ใหม่ ให้เขียนฟังก์ชันด้านบน แล้วเพิ่มบรรทัดในตารางนี้
# main.py ใช้ตารางนี้ตรวจด้วยว่าชื่อฟิลเตอร์ที่ส่งมาถูกต้องหรือไม่
FILTERS = {
    "grayscale": _grayscale,
    "sepia": _sepia,
    "warm": _warm,
    "cool": _cool,
    "vivid": _vivid,
    "vintage": _vintage,
    "cinematic": _cinematic,
    "sharpen": _sharpen,
    "sketch": _sketch,
    "cartoon": _cartoon,
}


# ---------------------------------------------------------------------------
# ฟังก์ชันหลัก (main.py เรียกใช้ตัวนี้)
# ---------------------------------------------------------------------------

def apply_filter(image_bytes: bytes, filter_name: str, intensity: int = 100) -> bytes:
    """ใส่ฟิลเตอร์ให้รูป แล้วคืนค่าเป็นไฟล์ PNG (bytes)

    image_bytes : ไฟล์รูปต้นฉบับ
    filter_name : ชื่อฟิลเตอร์ ต้องเป็นหนึ่งใน FILTERS
    intensity   : ความแรง -100..100
        0    = เหมือนรูปเดิม
        +100 = ฟิลเตอร์เต็มที่
        -100 = ฟิลเตอร์ "ด้านตรงข้ามเต็มที่" เช่น cool -> อุ่น, sharpen -> เบลอ,
               grayscale -> สีสดจัดขึ้น
    """
    handler = FILTERS.get(filter_name)
    if handler is None:
        raise ValueError(f"Unsupported filter: {filter_name}")
    if not INTENSITY_MIN <= intensity <= INTENSITY_MAX:
        raise ValueError(f"intensity must be between {INTENSITY_MIN} and {INTENSITY_MAX}")

    rgb = _load_image(image_bytes)
    filtered = handler(rgb)

    # สูตร: ผลลัพธ์ = ต้นฉบับ + k * (ฟิลเตอร์ - ต้นฉบับ)   โดย k = intensity / 100
    # k = 0 ได้รูปเดิม, k = 1 ได้ฟิลเตอร์เต็ม, k = 0.5 ได้ครึ่งทาง
    # k ติดลบ จะผลักค่าสีไปทางตรงข้ามกับที่ฟิลเตอร์ทำ
    k = intensity / 100.0
    original = rgb.astype(np.float32)
    result = original + k * (filtered.astype(np.float32) - original)

    return _encode_png(_clip(result))
