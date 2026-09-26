# services/cleaner.py
"""Cleaner: mask-guided removal of unwanted objects or watermarks.

Objects are removed with LaMa (simple-lama-inpainting), a local deep
inpainting model, so the result is fully erased and seamlessly filled in.
Watermarks/logos are thin, flat regions where classic OpenCV inpainting
already looks good and runs a lot faster, so that path is kept for it.
"""
from __future__ import annotations

import io
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageOps
from simple_lama_inpainting import SimpleLama

WATERMARK_INPAINT_RADIUS = 6   # thin/flat regions need less surrounding blend
MASK_THRESHOLD = 10            # mask pixels above this are treated as "remove this"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _load_image(image_bytes: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise ValueError("Invalid or corrupted image file") from exc
    return image.convert("RGB")


def _load_mask(mask_bytes: bytes, size: tuple[int, int]) -> Image.Image:
    """Load a mask; any pixel brighter than MASK_THRESHOLD marks an area to remove."""
    try:
        mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
    except Exception as exc:
        raise ValueError("Invalid or corrupted mask file") from exc
    if mask.size != size:
        mask = mask.resize(size)
    binary_mask = mask.point(lambda p: 0 if p > MASK_THRESHOLD else 255)
    inverted_mask = ImageOps.invert(binary_mask)
    return inverted_mask


def _encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# object removal: LaMa (local deep inpainting model)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_lama() -> SimpleLama:
    return SimpleLama()  # loaded once and reused across requests


def _remove_object(image: Image.Image, mask: Image.Image) -> Image.Image:
    mask_np = np.array(mask)
    kernel = np.ones((5, 5), np.uint8) # ปรับเลข (5, 5) เพิ่มขึ้นได้ถ้าอยากให้ขยายหนาขึ้นอีก
    dilated_mask_np = cv2.dilate(mask_np, kernel, iterations=2)
    mask = Image.fromarray(dilated_mask_np)
    result = _get_lama()(image, mask)
    if isinstance(result, np.ndarray):
        result = Image.fromarray(result.astype("uint8"))
    return result.convert("RGB")


# ---------------------------------------------------------------------------
# watermark removal: OpenCV inpainting (fast, local, fine for thin/flat areas)
# ---------------------------------------------------------------------------

def _remove_watermark(image: Image.Image, mask: Image.Image) -> Image.Image:
    bgr = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    binary_mask = np.array(mask)
    filled = cv2.inpaint(bgr, binary_mask, WATERMARK_INPAINT_RADIUS, cv2.INPAINT_NS)
    return Image.fromarray(cv2.cvtColor(filled, cv2.COLOR_BGR2RGB))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

CLEAN_MODES = {
    "object": _remove_object,
    "watermark": _remove_watermark,
}


def clean_image(image_bytes: bytes, mask_bytes: bytes, mode: str = "object") -> bytes:
    """Erase the area marked (white) in `mask_bytes` and fill it from the
    surrounding background. `mode="object"` runs LaMa's deep inpainting
    model for a seamless, fully-erased result; `mode="watermark"` uses
    faster OpenCV inpainting suited for flat logo/text areas.
    """
    handler = CLEAN_MODES.get(mode)
    if handler is None:
        raise ValueError(f"Unsupported mode: {mode}")

    image = _load_image(image_bytes)
    mask = _load_mask(mask_bytes, image.size)
    if not mask.getbbox():
        return image_bytes  # nothing marked, skip processing

    cleaned = handler(image, mask)
    return _encode_png(cleaned)



