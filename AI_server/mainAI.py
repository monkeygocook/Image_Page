import asyncio
import os

import patch
from fastapi.concurrency import run_in_threadpool
from services.generator import DEFAULT_SIZE, generate_image
from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from services.background import remove_background
from services.blur import background_blur, face_blur, gaussian_blur
from services.Filter import FILTERS, apply_filter
from services.adjust import adjust_image

app = FastAPI()

# Only MAX_CONCURRENT_JOBS heavy jobs run at once; others wait in the queue.
MAX_CONCURRENT_JOBS = int(os.getenv("MAX_CONCURRENT_JOBS", "1"))
MAX_QUEUE_SIZE = int(os.getenv("MAX_QUEUE_SIZE", "10"))
_job_slots = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
_pending_jobs = 0


async def run_queued(func, *args, **kwargs):
    global _pending_jobs
    if _pending_jobs >= MAX_QUEUE_SIZE + MAX_CONCURRENT_JOBS:
        raise HTTPException(status_code=503, detail={
            "error": {"code": "QUEUE_FULL", "message": "Server is busy, please try again later"}
        })
    _pending_jobs += 1
    try:
        async with _job_slots:
            return await run_in_threadpool(func, *args, **kwargs)
    finally:
        _pending_jobs -= 1


@app.get("/queue")
def queue_status():
    return {
        "pending": _pending_jobs,
        "max_concurrent": MAX_CONCURRENT_JOBS,
        "max_queue": MAX_QUEUE_SIZE,
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
    negative_prompt: str = ""
    seed: int = -1
    size: str = DEFAULT_SIZE

@app.post("/generate")
async def generate(req: GenerateRequest):
    try:
        image = await run_queued(
            generate_image,
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            seed=req.seed,
            size=req.size
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_SIZE", "message": str(exc)}
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
