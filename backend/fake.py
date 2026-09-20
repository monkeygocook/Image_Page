import io, uuid, asyncio
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
from PIL import Image, ImageDraw
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from contextvars import ContextVar
import base64, hmac, hashlib, json, time
from fastapi import Header, HTTPException
from datetime import datetime, timezone
from fastapi import Depends


_request_id: ContextVar[str] = ContextVar("request_id", default="")
app = FastAPI(title="Image_Page Fake Backend", version="1.0.0")


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    rid = request.headers.get("X-Request-Id") or str(uuid.uuid4())
    token = _request_id.set(rid)
    try:
        resp = await call_next(request)
    finally:
        _request_id.reset(token)
    resp.headers["X-Request-Id"] = rid
    return resp

@app.exception_handler(RequestValidationError)
async def on_validation_error(request: Request, exc: RequestValidationError):
    e = (exc.errors() or [{}])[0]
    field = ".".join(str(x) for x in e.get("loc", [])[1:]) or "body"
    return err("VALIDATION_ERROR", f"{field}: {e.get('msg', 'invalid')}", 422)

@app.exception_handler(StarletteHTTPException)
async def on_http_error(request: Request, exc: StarletteHTTPException):
    return err(f"HTTP_{exc.status_code}", str(exc.detail), exc.status_code)

@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception):
    return err("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}", 500)

PLACEHOLDER = "https://placehold.co/768x768/png?text=Fake+Result"

def job(status: str = "succeeded"):
    return {"job_id": str(uuid.uuid4()), "image_url": PLACEHOLDER, "status": status}



def render(text: str, media: str = "image/png", size=(1024, 1024), bg=(28, 30, 38)):
    img = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, size[0] - 20, size[1] - 20], outline=(120, 160, 255), width=6)
    d.text((60, 60), text, fill=(235, 240, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG" if media == "image/png" else "JPEG", quality=92)
    return Response(content=buf.getvalue(), media_type=media)

ACCEPT = {"image/png", "image/jpeg", "image/webp"}

async def check_image(image: UploadFile, max_mb: int):
    if image.content_type not in ACCEPT:
        return err("UNSUPPORTED_TYPE", f"ไม่รองรับชนิดไฟล์: {image.content_type}", 415)
    data = await image.read()
    if len(data) > max_mb * 1024 * 1024:
        return err("FILE_TOO_LARGE", f"ไฟล์เกิน {max_mb} MB", 413)
    return None

def err(code: str, message: str, http: int = 422):
    return JSONResponse(
        {"error": {"code": code, "message": message, "request_id": _request_id.get()}},
        status_code=http,
    )

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str | None = None
    
SECRET = "dev-secret-change-me"
USERS: dict[str, dict] = {}          # email -> record
NOTES: dict[str, str] = {}
PREFS: dict[str, dict] = {}

def _hash(pw: str) -> str:
    return hashlib.sha256((SECRET + pw).encode()).hexdigest()

def _token(email: str) -> str:
    raw = json.dumps({"sub": email, "exp": time.time() + 86400})
    sig = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:16]
    return base64.urlsafe_b64encode(f"{raw}|{sig}".encode()).decode()

def _public(u: dict) -> dict:
    return {"name": u["name"], "email": u["email"],
            "role": u["role"], "created_at": u["created_at"]}

def me_user(authorization: str | None = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "กรุณาเข้าสู่ระบบ")
    try:
        raw, sig = base64.urlsafe_b64decode(authorization[7:]).decode().rsplit("|", 1)
        good = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:16]
        data = json.loads(raw)
        assert hmac.compare_digest(sig, good) and data["exp"] > time.time()
        return USERS[data["sub"]]
    except Exception:
        raise HTTPException(401, "เซสชันหมดอายุ")


class AuthIn(BaseModel):
    name: str | None = None
    email: str
    password: str

@app.post("/api/v1/auth/register")
async def register(b: AuthIn):
    if b.email in USERS:
        return err("EMAIL_TAKEN", "อีเมลนี้ถูกใช้แล้ว", 409)
    if len(b.password) < 8:
        return err("WEAK_PASSWORD", "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", 422)
    USERS[b.email] = {
        "name": b.name or b.email.split("@")[0], "email": b.email,
        "pw": _hash(b.password), "role": "user",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    return {"user": _public(USERS[b.email]), "access_token": _token(b.email)}

@app.post("/api/v1/auth/login")
async def login(b: AuthIn):
    u = USERS.get(b.email)
    if not u or u["pw"] != _hash(b.password):
        return err("INVALID_CREDENTIALS", "อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401)
    return {"user": _public(u), "access_token": _token(b.email)}

@app.get("/api/v1/auth/me")
async def whoami(u: dict = Depends(me_user)):
    return {"user": _public(u)}

@app.post("/api/v1/auth/logout", status_code=204)
async def logout(u: dict = Depends(me_user)):
    return Response(status_code=204)

@app.get("/api/v1/notes")
async def get_notes(u: dict = Depends(me_user)):
    return {"content": NOTES.get(u["email"], "")}

@app.put("/api/v1/notes")
async def put_notes(body: dict, u: dict = Depends(me_user)):
    NOTES[u["email"]] = body.get("content", "")
    return {"ok": True}

@app.get("/api/v1/preferences")
async def get_prefs(u: dict = Depends(me_user)):
    return PREFS.get(u["email"], {"lang": "th", "tabs": None})

@app.put("/api/v1/preferences")
async def put_prefs(body: dict, u: dict = Depends(me_user)):
    PREFS[u["email"]] = body
    return {"ok": True}

@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}



@app.post("/api/v1/generate")
async def generate(req: GenerateRequest):
    if not req.prompt.strip():
        return err("INVALID_PROMPT", "prompt ต้องไม่ว่าง")
    await asyncio.sleep(0.8)
    return render(f"GENERATE\n{req.prompt[:60]}")

@app.post("/api/v1/remove-background")
async def remove_background(
    image: UploadFile = File(...),
    output: str = Form("transparent"),
    refine_edge: bool = Form(True),
):
    if (e := await check_image(image, 12)): return e
    await asyncio.sleep(0.8)
    return render(f"REMOVE-BG\noutput={output} refine={refine_edge}")

@app.post("/api/v1/clean-image")
async def clean_image(
    image: UploadFile = File(...),
    denoise: str = Form("medium"),
    remove_watermark: bool = Form(True),
):
    await image.read()
    await asyncio.sleep(0.8)
    return render(f"CLEAN\ndenoise={denoise} wm={remove_watermark}")

@app.post("/api/v1/color-grade")
async def color_grade(
    image: UploadFile = File(...),
    tone: str = Form("warm"),
    strength: int = Form(70),
):
    if not 0 <= strength <= 100:
        return err("INVALID_STRENGTH", "strength ต้องอยู่ระหว่าง 0–100")
    await image.read()
    await asyncio.sleep(0.8)
    return render(f"TONE\ntone={tone} strength={strength}%", media="image/jpeg")

@app.post("/api/v1/blur")
async def blur(
    image: UploadFile = File(...),
    blur_type: str = Form("gaussian"),
    blur_amount: int = Form(40),
):
    if blur_type not in {"gaussian", "background", "face", "motion", "pixelate", "radial"}:
        return err("INVALID_BLUR_TYPE", f"ไม่รองรับ blur_type: {blur_type}")
    if not 0 <= blur_amount <= 100:
        return err("INVALID_BLUR_AMOUNT", "blur_amount ต้องอยู่ระหว่าง 0–100")
    await image.read()
    await asyncio.sleep(0.8)
    return render(f"BLUR\ntype={blur_type} amount={blur_amount}%")



