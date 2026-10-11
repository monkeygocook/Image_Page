import base64
import os

import logging
log = logging.getLogger("generator")

import requests
from requests.exceptions import RequestException

FORGE_URL = os.getenv("FORGE_URL", "http://127.0.0.1:7860").rstrip("/")

# ขนาดที่อนุญาต (SD 1.5) — key ต้องตรงกับค่าใน config.js
IMAGE_SIZES = {
    "512x512": (512, 512),
    "512x768": (512, 768),
    "768x512": (768, 512),
    "768x768": (768, 768),
}
DEFAULT_SIZE = "512x768"


def generate_image(
    prompt: str,
    negative_prompt: str = "",
    seed: int = -1,
    size: str = DEFAULT_SIZE
):
    if size not in IMAGE_SIZES:
        raise ValueError(f"Unsupported size: {size}")
    width, height = IMAGE_SIZES[size]

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "seed": seed,
        "width": width,
        "height": height
    }

    try:
        response = requests.post(
            f"{FORGE_URL}/sdapi/v1/txt2img",
            json=payload,
            timeout=300
        )
    except RequestException as exc:
        # รายละเอียดจริง (มี URL) เก็บใน log เท่านั้น
        log.error("เชื่อมต่อ Forge ไม่ได้ที่ %s: %s", FORGE_URL, exc)
        raise RuntimeError(
            "ระบบสร้างภาพยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง"
        ) from exc

    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        log.error("Forge ตอบกลับ HTTP %s: %s", response.status_code, response.text[:300])
        raise RuntimeError(
            "ระบบสร้างภาพเกิดข้อผิดพลาด กรุณาลองใหม่"
        ) from exc

    # คำตอบจาก Forge ผิดรูปแบบ = ฝั่ง Forge มีปัญหา ไม่ใช่ข้อมูลผู้ใช้ผิด
    # จึงต้องเป็น RuntimeError (-> 503) ไม่ใช่ ValueError (-> 422)
    try:
        result = response.json()
        image_base64 = result["images"][0]
        if "," in image_base64[:100]:            # กันกรณีมี data:image/png;base64, นำหน้า
            image_base64 = image_base64.split(",", 1)[1]
        return base64.b64decode(image_base64)
    except Exception as exc:
        log.error("Forge ตอบกลับผิดรูปแบบ (HTTP %s): %s", response.status_code, response.text[:300])
        raise RuntimeError(
            "ระบบสร้างภาพเกิดข้อผิดพลาด กรุณาลองใหม่"
        ) from exc