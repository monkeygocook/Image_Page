import asyncio
import os
from typing import Optional

import patch
from fastapi.concurrency import run_in_threadpool
from services.generator import DEFAULT_SIZE, IMAGE_SIZES, LORAS, generate_image
from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from services.background import remove_background
from services.blur import background_blur, face_blur, gaussian_blur
from services.Filter import FILTERS, apply_filter
from services.adjust import adjust_image
from services.output_store import save_output

app = FastAPI()

# คิวแยก 2 สาย (lane) — งานสร้างภาพที่รอ Forge นาน ๆ ไม่ขวางงานแต่งภาพ
#   gen : /generate
#   img : /remove-background, /blur, /filter, /adjust
# ค่า MAX_CONCURRENT_* ต้องเท่ากับ GEN_CONCURRENCY / IMG_CONCURRENCY ของ backend
LANE_LIMITS = {
    # lane: (รันพร้อมกันได้กี่งาน, รอคิวได้กี่งาน)
    "gen": (int(os.getenv("MAX_CONCURRENT_GEN", "1")),
            int(os.getenv("MAX_QUEUE_GEN", os.getenv("MAX_QUEUE_SIZE", "10")))),
    "img": (int(os.getenv("MAX_CONCURRENT_IMG", os.getenv("MAX_CONCURRENT_JOBS", "1"))),
            int(os.getenv("MAX_QUEUE_IMG", os.getenv("MAX_QUEUE_SIZE", "10")))),
}
_job_slots = {lane: asyncio.Semaphore(c) for lane, (c, _) in LANE_LIMITS.items()}
_pending_jobs = {lane: 0 for lane in LANE_LIMITS}


def _run_and_save(func, *args, **kwargs):
    result = func(*args, **kwargs)
    if isinstance(result, (bytes, bytearray)):
        save_output(getattr(func, "__name__", "job"), bytes(result))
    return result


async def run_queued(func, *args, lane: str = "img", **kwargs):
    concurrent, max_queue = LANE_LIMITS[lane]
    if _pending_jobs[lane] >= max_queue + concurrent:
        raise HTTPException(status_code=503, detail={
            "error": {"code": "QUEUE_FULL", "message": "Server is busy, please try again later"}
        })
    _pending_jobs[lane] += 1
    try:
        async with _job_slots[lane]:
            return await run_in_threadpool(_run_and_save, func, *args, **kwargs)
    finally:
        _pending_jobs[lane] -= 1


@app.get("/queue")
def queue_status():
    return {
        lane: {
            "pending": _pending_jobs[lane],
            "max_concurrent": concurrent,
            "max_queue": max_queue,
        }
        for lane, (concurrent, max_queue) in LANE_LIMITS.items()
    }

BLUR_HANDLERS = {
    "gaussian": gaussian_blur,
    "background": background_blur,
    "face": face_blur,
}


@app.get("/health")
def health():
    return {
        "status": "ok"
    }


@app.post("/remove-background")
async def remove_bg(
    image: UploadFile = File(...),
    output: str = Form("transparent"),
    refine_edge: bool = Form(True)
):
    image_bytes = await image.read()

    try:
        result = await run_queued(remove_background, image_bytes, output, refine_edge)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_IMAGE", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )


class GenerateRequest(BaseModel):
    prompt: str
    # รับ None ได้ด้วย กัน 422 เมื่อฝั่งหน้าเว็บส่ง null มา
    negative_prompt: Optional[str] = ""
    seed: Optional[int] = -1
    size: Optional[str] = DEFAULT_SIZE
    # "none" / null / ไม่ส่งมา = ไม่ใช้ LoRA
    lora: Optional[str] = "none"


MAX_PROMPT_LEN = 2000


@app.post("/generate")
async def generate(req: GenerateRequest):
    prompt = (req.prompt or "").strip()
    size = req.size or DEFAULT_SIZE
    if not prompt or len(prompt) > MAX_PROMPT_LEN:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_PROMPT",
                      "message": f"prompt must be 1-{MAX_PROMPT_LEN} characters"}
        })
    lora = (req.lora or "none").strip()
    if lora != "none" and lora not in LORAS:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_LORA", "message": f"Unsupported lora: {lora}"}
        })
    # ตรวจ size ตรงนี้ — ไม่พึ่ง except ValueError ครอบทั้งก้อน
    # เพราะ JSONDecodeError / base64 error จาก Forge ก็เป็น ValueError ด้วย
    if size not in IMAGE_SIZES:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_SIZE", "message": f"Unsupported size: {size}"}
        })
    try:
        image = await run_queued(
            generate_image,
            lane="gen",
            prompt=prompt,
            negative_prompt=(req.negative_prompt or "").strip(),
            seed=req.seed if req.seed is not None else -1,
            size=size,
            loras=[] if lora == "none" else [lora]
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_REQUEST", "message": str(exc)}
        }) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=image,
        media_type="image/png"
    )


@app.post("/adjust")
async def adjust_endpoint(
    image: UploadFile = File(...),
    brightness: int = Form(0),
    contrast: int = Form(0),
    saturation: int = Form(0),
    temperature: int = Form(0),
    vignette: int = Form(0)
):
    image_bytes = await image.read()

    try:
        result = await run_queued(
            adjust_image,
            image_bytes, brightness, contrast, saturation, temperature, vignette
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_ADJUST_REQUEST", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )


@app.post("/filter")
async def filter_image(
    image: UploadFile = File(...),
    filter_name: str = Form("grayscale"),
    intensity: int = Form(100)
):
    if filter_name not in FILTERS:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_FILTER", "message": f"Unsupported filter_name: {filter_name}"}
        })

    if not -100 <= intensity <= 100:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_INTENSITY", "message": "intensity must be between -100 and 100"}
        })

    image_bytes = await image.read()

    try:
        result = await run_queued(apply_filter, image_bytes, filter_name, intensity)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_IMAGE", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )


@app.post("/blur")
async def blur(
    image: UploadFile = File(...),
    blur_type: str = Form("gaussian"),
    blur_amount: int = Form(40)
):
    handler = BLUR_HANDLERS.get(blur_type)
    if handler is None:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_BLUR_TYPE", "message": f"Unsupported blur_type: {blur_type}"}
        })

    if not 0 <= blur_amount <= 100:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_BLUR_AMOUNT", "message": "blur_amount must be between 0 and 100"}
        })

    image_bytes = await image.read()

    try:
        result = await run_queued(handler, image_bytes, blur_amount)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_IMAGE", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )
