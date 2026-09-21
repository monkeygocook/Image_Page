# services/background.py

from rembg import remove

def remove_background(image_bytes: bytes):
    result = remove(image_bytes)
    return result