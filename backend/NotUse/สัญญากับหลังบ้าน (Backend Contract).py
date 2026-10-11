from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.post("/remove-background")
async def remove_bg(image: UploadFile = File(...),
                    output: str = Form("transparent"),
                    refine_edge: str = Form("true")):
    raw = await image.read()
    result = your_bg_removal(raw, output, refine_edge == "true")   # ← ใส่โมเดลตรงนี้
    return Response(content=result, media_type="image/png")