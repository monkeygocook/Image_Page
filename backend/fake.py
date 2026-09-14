import uuid, asyncio
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Image_Page Fake Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)

@app.middleware("http")
async def add_request_id(request: Request, call_next):
    rid = request.headers.get("X-Request-Id") or str(uuid.uuid4())
    resp = await call_next(request)
    resp.headers["X-Request-Id"] = rid
    return resp

PLACEHOLDER = "https://placehold.co/768x768/png?text=Fake+Result"

def job(status: str = "succeeded"):
    return {"job_id": str(uuid.uuid4()), "image_url": PLACEHOLDER, "status": status}

def err(code: str, message: str, http: int = 400):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=http)

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str | None = None

@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}

@app.post("/api/v1/generate")
async def generate(req: GenerateRequest):
    if not req.prompt.strip():
        return err("INVALID_PROMPT", "prompt ต้องไม่ว่าง", 422)
    await asyncio.sleep(0.8)
    return job()

@app.post("/api/v1/remove-background")
async def remove_background(image: UploadFile = File(...)):
    await image.read()
    await asyncio.sleep(0.8)
    return job()

@app.post("/api/v1/clean-image")
async def clean_image(image: UploadFile = File(...)):
    await image.read()
    await asyncio.sleep(0.8)
    return job()

@app.post("/api/v1/color-grade")
async def color_grade(image: UploadFile = File(...), preset: str = Form("warm")):
    await image.read()
    await asyncio.sleep(0.8)
    return job()

@app.post("/api/v1/blur")
async def blur(image: UploadFile = File(...), strength: int = Form(5)):
    if not 1 <= strength <= 20:
        return err("INVALID_STRENGTH", "strength ต้องอยู่ระหว่าง 1–20", 422)
    await image.read()
    await asyncio.sleep(0.8)
    return job()

