# services/background.py

import onnxruntime as ort
import os
from functools import lru_cache

from rembg import new_session, remove

# ซ่อน warning ของ onnxruntime (แสดงเฉพาะ error ขึ้นไป)
ort.set_default_logger_severity(3)

import io

from PIL import Image, ImageFilter

OUTPUT_COLORS = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
}


@lru_cache(maxsize=1)
def get_session():
    # โหลดโมเดลครั้งเดียวแล้วใช้ซ้ำ (เปลี่ยนโมเดลได้ด้วย REMBG_MODEL)
    return new_session(os.getenv("REMBG_MODEL", "u2net"))


def remove_background(image_bytes: bytes, output: str = "transparent", refine_edge: bool = True):
    if output != "transparent" and output not in OUTPUT_COLORS:
        raise ValueError(f"Unsupported output: {output}")

    cutout = Image.open(io.BytesIO(remove(image_bytes, session=get_session()))).convert("RGBA")

    if refine_edge:
        r, g, b, alpha = cutout.split()
        alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1))
        cutout = Image.merge("RGBA", (r, g, b, alpha))

    if output in OUTPUT_COLORS:
        canvas = Image.new("RGBA", cutout.size, OUTPUT_COLORS[output] + (255,))
        canvas.alpha_composite(cutout)
        cutout = canvas.convert("RGB")

    buf = io.BytesIO()
    cutout.save(buf, format="PNG")
    return buf.getvalue()