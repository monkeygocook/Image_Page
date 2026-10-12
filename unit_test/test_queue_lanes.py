"""
ทดสอบ: คิวแยก 2 สาย
    gen : generate
    img : remove-background, blur, filter, adjust

สิ่งที่ต้องเป็นจริง
- ระหว่างที่ generate กำลังรอ Forge (นานได้หลายนาที) งานในสาย img ยังทำได้ทันที
- ในสายเดียวกันยังเข้าคิวตามลำดับ (FIFO) ทีละงาน
- ลำดับคิวของแต่ละสายนับแยกกัน

ทุกอย่างรันในโปรเซสเดียว: backend → AI จริง (mainAI.py) → Forge จำลองที่ "ค้าง" ไว้จนกว่าจะปล่อย
"""
import asyncio
import base64
import io
import threading
import time

import httpx
import pytest
import requests
from PIL import Image

import mainBackend as backend


def png(color=(200, 100, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(buf, "PNG")
    return buf.getvalue()


FORGE_PNG = png((10, 20, 30))
AI_IMG_RESULT = png((1, 2, 3))


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def system(db_path, ai_main, monkeypatch):
    """backend + AI จริงในโปรเซสเดียว, Forge จำลองที่ค้างจนกว่าจะสั่ง release"""
    release = threading.Event()
    forge_calls = []

    class ForgeReply:
        status_code = 200
        text = ""
        def raise_for_status(self): pass
        def json(self): return {"images": [base64.b64encode(FORGE_PNG).decode()]}

    def slow_forge(url, json=None, timeout=None, **kw):
        forge_calls.append(time.time())
        release.wait(10)                      # จำลอง Forge ที่ใช้เวลานาน
        return ForgeReply()

    monkeypatch.setattr(requests, "post", slow_forge)
    monkeypatch.setattr(ai_main, "remove_background", lambda *a, **k: AI_IMG_RESULT)

    # สร้างคิวใหม่ทุก test (Semaphore ผูกกับ event loop)
    monkeypatch.setattr(backend, "LANES", {
        "gen": backend.Lane(1, 10),
        "img": backend.Lane(1, 10),
    })
    monkeypatch.setattr(ai_main, "_job_slots",
                        {lane: asyncio.Semaphore(c) for lane, (c, _) in ai_main.LANE_LIMITS.items()})
    monkeypatch.setattr(ai_main, "_pending_jobs", {lane: 0 for lane in ai_main.LANE_LIMITS})
    monkeypatch.setattr(backend, "_cond", asyncio.Condition())
    monkeypatch.setattr(backend, "_ai_client", httpx.AsyncClient(
        transport=httpx.ASGITransport(app=ai_main.app), base_url="http://ai.test", timeout=30))

    yield {"release": release, "forge_calls": forge_calls}
    release.set()


async def login(client, email):
    r = await client.post("/api/v1/auth/register",
                          json={"name": email, "email": email, "password": "Password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=backend.app),
                             base_url="http://backend.test", timeout=30)


async def wait_until(cond, timeout=5):
    t0 = time.time()
    while not cond():
        if time.time() - t0 > timeout:
            raise AssertionError("รอนานเกินไป")
        await asyncio.sleep(0.02)


@pytest.mark.anyio
async def test_image_job_is_not_blocked_by_running_generate(system):
    async with client() as c:
        a = await login(c, "gen-user@example.com")
        b = await login(c, "bg-user@example.com")

        gen = asyncio.create_task(c.post("/api/v1/generate", json={"prompt": "a cat"}, headers=a))
        await wait_until(lambda: system["forge_calls"])          # generate กำลังรอ Forge อยู่

        t0 = time.time()
        bg = await c.post("/api/v1/remove-background",
                          files={"image": ("p.png", png(), "image/png")}, headers=b)
        took = time.time() - t0

        assert bg.status_code == 200, bg.text
        assert bg.content == AI_IMG_RESULT
        assert took < 2, f"ลบพื้นหลังต้องรอ {took:.1f}s — ยังติดคิวเดียวกับ generate"
        assert not gen.done(), "generate ควรยังรอ Forge อยู่"

        system["release"].set()
        r = await gen
        assert r.status_code == 200, r.text
        assert r.content == FORGE_PNG


@pytest.mark.anyio
async def test_generate_jobs_still_queue_fifo_in_their_own_lane(system):
    async with client() as c:
        a = await login(c, "first@example.com")
        b = await login(c, "second@example.com")
        d = await login(c, "editor@example.com")

        j1 = (await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])
        j2 = (await c.post("/api/v1/jobs/generate", json={"prompt": "two"}, headers=b)).json()

        assert j1["lane"] == j2["lane"] == "gen"
        assert j2["status"] == "queued" and j2["position"] == 1, j2       # ต่อคิวหลังงานแรก

        # งานแต่งภาพมีคิวของตัวเอง ไม่ต้องนับงาน gen ที่รออยู่
        j3 = (await c.post("/api/v1/jobs/remove-background",
                           files={"image": ("p.png", png(), "image/png")}, headers=d)).json()
        assert j3["lane"] == "img"
        assert j3.get("position", 0) <= 1 and j3.get("ahead", 0) == 0, j3
        await wait_until(lambda: backend.JOBS[j3["job_id"]].status == "done")
        assert backend.JOBS[j2["job_id"]].status == "queued"            # งาน gen ที่สองยังรออยู่

        system["release"].set()
        await wait_until(lambda: backend.JOBS[j2["job_id"]].status == "done", timeout=10)
        assert len(system["forge_calls"]) == 2
        assert system["forge_calls"][0] <= system["forge_calls"][1]      # FIFO


@pytest.mark.anyio
async def test_queue_status_shows_both_lanes(system):
    async with client() as c:
        r = await c.get("/api/v1/queue")
        assert r.status_code == 200
        assert set(r.json()) == {"gen", "img"}


# ---------------------------------------------------------------- BE-18/19/20 ทำงานแยกตามสาย

@pytest.mark.anyio
async def test_queue_state_endpoint_reports_position_in_own_lane(system):
    async with client() as c:
        a = await login(c, "q1@example.com")
        b = await login(c, "q2@example.com")
        j1 = (await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])
        j2 = (await c.post("/api/v1/jobs/generate", json={"prompt": "two"}, headers=b)).json()

        s = (await c.get(f"/api/v1/queue/{j2['job_id']}", headers=b)).json()      # BE-18
        assert s["lane"] == "gen" and s["state"] == "queued"
        assert s["position"] == 1 and s["total"] == 2
        system["release"].set()


@pytest.mark.anyio
async def test_cancel_frees_slot_in_its_lane(system):
    async with client() as c:
        a = await login(c, "c1@example.com")
        b = await login(c, "c2@example.com")
        await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)
        await wait_until(lambda: system["forge_calls"])
        j2 = (await c.post("/api/v1/jobs/generate", json={"prompt": "two"}, headers=b)).json()
        assert j2["job_id"] in backend.LANES["gen"].queue

        r = await c.delete(f"/api/v1/jobs/{j2['job_id']}", headers=b)               # BE-20
        assert r.status_code == 204
        await wait_until(lambda: j2["job_id"] not in backend.LANES["gen"].queue)
        system["release"].set()


@pytest.mark.anyio
async def test_long_generate_estimate_only_rejects_generate(system, monkeypatch):
    """BE-19: ประเมินว่าสาย gen ต้องรอนานเกินกำหนด -> ปฏิเสธเฉพาะงาน gen ใหม่ งานแต่งภาพยังรับได้"""
    from collections import deque
    monkeypatch.setitem(backend.DURATIONS, "generate", deque([200.0]))             # สร้างภาพใช้ ~200 วินาที
    async with client() as c:
        a = await login(c, "l4@example.com")
        b = await login(c, "l5@example.com")
        d = await login(c, "l6@example.com")
        r1 = await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)
        assert r1.status_code == 202, r1.text
        await wait_until(lambda: system["forge_calls"])
        r2 = await c.post("/api/v1/jobs/generate", json={"prompt": "two"}, headers=b)  # 200 รอ + 200 = 400 > 300
        assert r2.status_code == 503 and r2.json()["error"]["code"] == "QUEUE_FULL"
        r3 = await c.post("/api/v1/jobs/remove-background",
                          files={"image": ("p.png", png(), "image/png")}, headers=d)
        assert r3.status_code == 202, f"งานแต่งภาพโดนปฏิเสธเพราะเวลารอของสาย gen: {r3.text}"
        system["release"].set()
