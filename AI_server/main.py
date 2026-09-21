from fastapi import FastAPI, File, UploadFile
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