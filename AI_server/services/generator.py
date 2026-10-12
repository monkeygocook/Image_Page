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

# LoRA ที่อนุญาต (SDXL) — key คือชื่อที่หน้าเว็บส่งมา, file ต้องตรงกับชื่อไฟล์ใน models/Lora
LORAS = {
    "pixel_art": {"file": "pixel-art-xl-v1.1", "trigger": "pixel art", "weight": 1.0},
    "outline": {"file": "outline_xl_kohaku_delta_spv5x", "trigger": "", "weight": 0.8},
    "lineart": {"file": "LineAniRedmondV2-Lineart-LineAniAF", "trigger": "lineart, LineAniAF", "weight": 0.8},
}


def build_lora_prompt(prompt: str, loras: list[str] | None) -> str:
    if not loras:
        return prompt
    parts = [prompt]
    for name in dict.fromkeys(loras):
        lora = LORAS.get(name)
        if lora is None:
            raise ValueError(f"Unsupported lora: {name}")
        if lora["trigger"]:
            parts.append(lora["trigger"])
        parts.append(f"<lora:{lora['file']}:{lora['weight']}>")
    return ", ".join(parts)


def generate_image(
    prompt: str,
    negative_prompt: str = "",
    seed: int = -1,
    size: str = DEFAULT_SIZE,
    loras: list[str] | None = None
):
    if size not in IMAGE_SIZES:
        raise ValueError(f"Unsupported size: {size}")
    width, height = IMAGE_SIZES[size]
    prompt = build_lora_prompt(prompt, loras)

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

    result = response.json()

    image_base64 = result["images"][0]

    return base64.b64decode(image_base64)