import base64
import os

import requests
from requests.exceptions import RequestException


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
        raise RuntimeError(
            f"เชื่อมต่อ Forge ไม่ได้ที่ {FORGE_URL}. "
            "กรุณาเปิด Stable Diffusion Forge และเปิด API ก่อน"
        ) from exc

    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        raise RuntimeError(
            f"Forge ตอบกลับ HTTP {response.status_code}: {response.text[:300]}"
        ) from exc

    result = response.json()

    image_base64 = result["images"][0]

    return base64.b64decode(image_base64)