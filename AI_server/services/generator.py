import base64
import os

import logging

import requests
from requests.exceptions import RequestException

log = logging.getLogger("generator")

FORGE_URL = os.getenv("FORGE_URL", "http://127.0.0.1:7860").rstrip("/")


def generate_image(
    prompt: str,
    negative_prompt: str = "",
    seed: int = -1
):
    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "seed": seed
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

    result = response.json()

    image_base64 = result["images"][0]

    return base64.b64decode(image_base64)