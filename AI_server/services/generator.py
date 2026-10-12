import base64
import os

import logging
log = logging.getLogger("generator")

import requests
from requests.exceptions import RequestException

FORGE_URL = os.getenv("FORGE_URL", "http://127.0.0.1:7860").rstrip("/")

# ขนาดที่อนุญาต (ใช้กับ SDXL) — key ต้องตรงกับค่าใน config.js
IMAGE_SIZES = {
    "512x512": (512, 512),
    "512x768": (512, 768),
    "768x512": (768, 512),
    "768x768": (768, 768),
}
DEFAULT_SIZE = "512x768"

# LoRA ที่อนุญาต (SDXL) — key คือชื่อที่หน้าเว็บส่งมา, file ต้องตรงกับชื่อไฟล์ใน models/Lora
LORAS = {
    "pixel_art": {"file": "pixelbuildings128-v2", "trigger": "", "weight": 1.0},
    "outline": {"file": "outline_xl_kohaku_delta_spv5x", "trigger": "", "weight": 1.0},
    "linear_manga": {"file": "LineAniRedmondV2-Lineart-LineAniAF", "trigger": "lineart, LineAniAF", "weight": 1.0},
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

def get_progress() -> dict:
    """ความคืบหน้าของงานที่ Forge กำลังวาดอยู่ (ใช้แสดงแถบเปอร์เซ็นต์บนหน้าเว็บ)

    Forge มี GET /sdapi/v1/progress บอก progress 0.0–1.0 และเวลาที่เหลือโดยประมาณ (eta_relative)
    สาย gen รันทีละงาน ค่าที่ได้จึงเป็นของงานที่กำลังทำอยู่
    เรียกไม่สำเร็จ -> progress = None (หน้าเว็บจะใช้การประมาณจากเวลาแทน)
    """
    try:
        r = requests.get(
            f"{FORGE_URL}/sdapi/v1/progress",
            params={"skip_current_image": "true"},   # ไม่ต้องส่งภาพตัวอย่างกลับมา (เบา)
            timeout=3,
        )
        r.raise_for_status()
        d = r.json()
    except Exception as exc:
        log.debug("อ่าน progress จาก Forge ไม่ได้: %s", exc)
        return {"progress": None}

    state = d.get("state") or {}
    progress = float(d.get("progress") or 0.0)
    return {
        "progress": max(0.0, min(1.0, progress)),
        "eta_sec": d.get("eta_relative"),
        "step": state.get("sampling_step"),
        "steps": state.get("sampling_steps"),
        "active": progress > 0 or bool(state.get("job_count")),
    }
