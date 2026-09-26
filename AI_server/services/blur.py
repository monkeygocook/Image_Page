# services/blur.py
"""Blur effects: gaussian_blur (whole image), background_blur (subject kept sharp),
and face_blur (only detected faces blurred). All three share the same
load -> blur -> mask -> composite -> encode pipeline via the helpers below.
"""
from __future__ import annotations

import io
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from rembg import remove

MAX_BLUR_RADIUS = 25.0          # PIL GaussianBlur radius at blur_amount=100
FACE_DETECT_MAX_DIM = 640       # downscale cap for face detection (perf, not output quality)
FACE_MASK_FEATHER = 15          # px radius used to soften mask edges around faces
FACE_CASCADE_PATH = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _clamp_amount(blur_amount: int) -> int:
    return max(0, min(100, blur_amount))


def _amount_to_radius(blur_amount: int) -> float:
    return (_clamp_amount(blur_amount) / 100) * MAX_BLUR_RADIUS


def _load_image(image_bytes: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise ValueError("Invalid or corrupted image file") from exc
    return image.convert("RGBA")


def _encode_png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _gaussian(image: Image.Image, radius: float) -> Image.Image:
    return image.filter(ImageFilter.GaussianBlur(radius))


def _composite(sharp: Image.Image, blurred: Image.Image, mask: Image.Image) -> Image.Image:
    """mask is an 'L' image: 255 keeps `sharp`, 0 keeps `blurred`."""
    return Image.composite(sharp, blurred, mask)


# ---------------------------------------------------------------------------
# gaussian_blur
# ---------------------------------------------------------------------------

def gaussian_blur(image_bytes: bytes, blur_amount: int = 40) -> bytes:
    """Blur the entire image uniformly."""
    radius = _amount_to_radius(blur_amount)
    if radius <= 0:
        return image_bytes  # nothing to do, skip decode/encode round-trip

    image = _load_image(image_bytes)
    return _encode_png(_gaussian(image, radius))


# ---------------------------------------------------------------------------
# background_blur
# ---------------------------------------------------------------------------

def _foreground_mask(image: Image.Image) -> Image.Image:
    """Run background removal and return its alpha channel as the sharp-subject mask."""
    cutout_bytes = remove(_encode_png(image))
    cutout = Image.open(io.BytesIO(cutout_bytes)).convert("RGBA")
    return cutout.getchannel("A")


def background_blur(image_bytes: bytes, blur_amount: int = 40) -> bytes:
    """Keep the detected subject sharp and blur everything behind it."""
    radius = _amount_to_radius(blur_amount)
    if radius <= 0:
        return image_bytes

    image = _load_image(image_bytes)
    mask = _foreground_mask(image)
    blurred = _gaussian(image, radius)
    return _encode_png(_composite(image, blurred, mask))


# ---------------------------------------------------------------------------
# face_blur
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_face_cascade() -> cv2.CascadeClassifier:
    cascade = cv2.CascadeClassifier(FACE_CASCADE_PATH)
    if cascade.empty():
        raise RuntimeError("Failed to load face detection model")
    return cascade


def _detect_faces(image: Image.Image) -> list[tuple[int, int, int, int]]:
    """Detect faces and return (x, y, w, h) boxes in `image`'s coordinate space."""
    width, height = image.size
    scale = min(1.0, FACE_DETECT_MAX_DIM / max(width, height))

    detect_target = image
    if scale < 1.0:
        detect_target = image.resize((max(1, int(width * scale)), max(1, int(height * scale))))

    gray = np.array(detect_target.convert("L"))
    boxes = _get_face_cascade().detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
    )

    if scale == 1.0:
        return [tuple(box) for box in boxes]
    return [tuple(int(v / scale) for v in box) for box in boxes]


def _face_mask(size: tuple[int, int], boxes: list[tuple[int, int, int, int]]) -> Image.Image:
    """Build a soft-edged mask with white ellipses over each detected face."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for x, y, w, h in boxes:
        draw.ellipse((x, y, x + w, y + h), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(FACE_MASK_FEATHER))


def face_blur(image_bytes: bytes, blur_amount: int = 40) -> bytes:
    """Blur only the regions where a face is detected; leaves image untouched if none found."""
    radius = _amount_to_radius(blur_amount)
    if radius <= 0:
        return image_bytes

    image = _load_image(image_bytes)
    boxes = _detect_faces(image)
    if not boxes:
        return image_bytes  # graceful fallback: nothing detected, don't alter the image

    mask = _face_mask(image.size, boxes)
    blurred = _gaussian(image, radius)
    return _encode_png(_composite(blurred, image, mask))
