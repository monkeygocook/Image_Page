import logging
import os
import secrets
import threading
from datetime import datetime
from pathlib import Path

log = logging.getLogger("output_store")

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", Path(__file__).resolve().parent.parent / "outputs"))
MAX_OUTPUTS = int(os.getenv("MAX_OUTPUTS", "5"))

_lock = threading.Lock()


def save_output(kind: str, data: bytes) -> None:
    """เก็บภาพผลลัพธ์ล่าสุดไว้ MAX_OUTPUTS ภาพ ลบอันเก่าสุดทิ้ง — พลาดแล้วไม่กระทบคำขอ"""
    try:
        kind = "".join(ch if ch.isalnum() or ch in "-_" else "" for ch in kind) or "job"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}_{kind}_{secrets.token_hex(2)}.png"
        with _lock:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            tmp = OUTPUT_DIR / (name + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(OUTPUT_DIR / name)

            files = sorted(OUTPUT_DIR.glob("*.png"), key=lambda p: p.name)
            for old in files[:-MAX_OUTPUTS]:
                old.unlink(missing_ok=True)
    except Exception as exc:
        log.warning("บันทึกภาพลง outputs ไม่สำเร็จ: %s", exc)
