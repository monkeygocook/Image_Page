from services.generator import generate_image
from pydantic import BaseModel
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

from services.background import remove_background

app = FastAPI()


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
