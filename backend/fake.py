from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)

# ต้องมี endpoint นี้ด้วยเพื่อให้หน้าเว็บรู้จัก
@app.get("/api/v1/health")
def health():
    return {"status": "ok", "version": "0.0.1-fake"}