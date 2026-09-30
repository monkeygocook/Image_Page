import patch
from services.generator import generate_image
from pydantic import BaseModel
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from services.background import remove_background
from services.blur import background_blur, face_blur, gaussian_blur
from services.cleaner import clean_image

app = FastAPI()

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
    image: UploadFile = File(...)
):
    image_bytes = await image.read()

    result = remove_background(image_bytes)

    return Response(
        content=result,
        media_type="image/png"
    )


@app.post("/clean-image")
async def clean_image_endpoint(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    mode: str = Form("object")
):
    image_bytes = await image.read()
    mask_bytes = await mask.read()

    try:
        result = clean_image(image_bytes, mask_bytes, mode)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_CLEAN_REQUEST", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    seed: int = -1

@app.post("/generate")
def generate(req: GenerateRequest):
    try:
        image = generate_image(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            seed=req.seed
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=image,
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
        result = handler(image_bytes, blur_amount)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={
            "error": {"code": "INVALID_IMAGE", "message": str(exc)}
        }) from exc

    return Response(
        content=result,
        media_type="image/png"
    )
