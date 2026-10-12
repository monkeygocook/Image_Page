"""
ทดสอบ: แถบเปอร์เซ็นต์ความคืบหน้า

    Forge  GET /sdapi/v1/progress  (progress 0–1, eta_relative)
      → AI  GET /generate/progress  (services/generator.get_progress)
      → backend ถามทุก PROGRESS_POLL_SEC ระหว่างที่ generate รันอยู่
      → สถานะงาน (SSE /api/v1/jobs/{id}/events, GET /api/v1/queue/{id}) มี progress / eta_sec
      → หน้าเว็บ (eta.js) แสดง % บนปุ่ม

งานแต่งภาพ (img) ไม่มี % จริง → backend ส่ง elapsed_sec / avg_sec ให้หน้าเว็บประมาณเอง
"""
import asyncio
from collections import deque

import pytest
import requests
from fastapi.testclient import TestClient

import mainBackend as backend
from test_queue_lanes import anyio_backend, client, login, png, system, wait_until  # noqa: F401


class Reply:
    def __init__(self, data, status=200):
        self._d, self.status_code = data, status
    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))
    def json(self):
        return self._d


def forge_progress(p, eta=5.0, step=None, steps=20, job_count=1):
    return {"progress": p, "eta_relative": eta, "current_image": None,
            "state": {"sampling_step": step if step is not None else int(p * steps),
                      "sampling_steps": steps, "job_count": job_count}}


@pytest.fixture
def fake_forge_progress(monkeypatch):
    """Forge จำลอง: ทุกครั้งที่ถาม % จะเพิ่มขึ้นทีละ 25"""
    seen = {"n": 0}

    def get(url, params=None, timeout=None, **kw):
        assert url.endswith("/sdapi/v1/progress"), url
        seen["n"] += 1
        p = min(0.25 * seen["n"], 0.95)
        return Reply(forge_progress(p, eta=10 * (1 - p)))

    monkeypatch.setattr(requests, "get", get)
    monkeypatch.setattr(backend, "PROGRESS_POLL_SEC", 0.05)
    return seen


# ---------------------------------------------------------------- AI: /generate/progress

def test_ai_progress_endpoint_reads_forge(ai_main, monkeypatch):
    monkeypatch.setattr(requests, "get", lambda *a, **k: Reply(forge_progress(0.4, eta=6.2, step=8)))
    r = TestClient(ai_main.app).get("/generate/progress")
    assert r.status_code == 200
    d = r.json()
    assert d["progress"] == pytest.approx(0.4)
    assert d["eta_sec"] == pytest.approx(6.2)
    assert d["step"] == 8 and d["steps"] == 20
    assert d["active"] is True


def test_ai_progress_endpoint_when_forge_is_off(ai_main, monkeypatch):
    def down(*a, **k):
        raise requests.ConnectionError("refused")
    monkeypatch.setattr(requests, "get", down)
    r = TestClient(ai_main.app).get("/generate/progress")
    assert r.status_code == 200
    assert r.json() == {"progress": None}


def test_ai_progress_endpoint_idle_forge(ai_main, monkeypatch):
    monkeypatch.setattr(requests, "get", lambda *a, **k: Reply(forge_progress(0.0, eta=None, job_count=0)))
    d = TestClient(ai_main.app).get("/generate/progress").json()
    assert d["progress"] == 0.0 and d["active"] is False


# ---------------------------------------------------------------- backend: ส่ง % ต่อให้หน้าเว็บ

@pytest.mark.anyio
async def test_generate_job_reports_increasing_progress(system, fake_forge_progress):
    async with client() as c:
        a = await login(c, "p1@example.com")
        j = (await c.post("/api/v1/jobs/generate", json={"prompt": "a cat"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])

        job = backend.JOBS[j["job_id"]]
        seen = []

        async def collect():
            while len(seen) < 3:
                if job.progress is not None and (not seen or job.progress != seen[-1]):
                    seen.append(job.progress)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(collect(), 5)
        assert seen == sorted(seen) and seen[0] < seen[-1], seen
        assert all(0 <= p <= 99 for p in seen), "ระหว่างทำต้องไม่ถึง 100%"

        s = (await c.get(f"/api/v1/queue/{j['job_id']}", headers=a)).json()     # BE-18 ก็มี %
        assert s["state"] == "processing" or s.get("status") == "running", s
        assert isinstance(s.get("progress"), int) and "eta_sec" in s and "elapsed_sec" in s

        system["release"].set()
        await wait_until(lambda: job.status == "done", timeout=10)
        s = (await c.get(f"/api/v1/queue/{j['job_id']}", headers=a)).json()
        assert s["progress"] == 100


@pytest.mark.anyio
async def test_progress_reaches_frontend_through_sse(system, fake_forge_progress):
    """อ่าน SSE แบบเดียวกับ api.js processJob — ต้องเห็น % หลายค่าก่อน done"""
    async with client() as c:
        a = await login(c, "p2@example.com")
        j = (await c.post("/api/v1/jobs/generate", json={"prompt": "a dog"}, headers=a)).json()

        statuses = []

        # httpx.ASGITransport รอจนได้ response ครบก่อนคืนค่า (สตรีมไม่ได้)
        # จึงอ่านจากตัวสร้าง SSE ของ endpoint ตรง ๆ — ได้ข้อความเดียวกับที่เบราว์เซอร์ได้
        class Req:
            async def is_disconnected(self):
                return False

        user = {"email": "p2@example.com"}
        res = await backend.job_events(j["job_id"], Req(), user)

        async def read_sse():
            import json
            async for chunk in res.body_iterator:
                line = next((l for l in chunk.split("\n") if l.startswith("data: ")), None)
                if not line:
                    continue
                s = json.loads(line[6:])
                statuses.append(s)
                if len([x for x in statuses if x.get("progress") is not None
                        and x["status"] == "running"]) >= 2:
                    system["release"].set()        # เห็น % แล้ว 2 ครั้ง ปล่อยให้ Forge เสร็จ
                if s["status"] in ("done", "error", "cancelled"):
                    return

        await asyncio.wait_for(read_sse(), 10)
        running = [s["progress"] for s in statuses if s["status"] == "running" and "progress" in s]
        assert len(running) >= 2, statuses
        assert running == sorted(running)
        assert statuses[-1]["status"] == "done" and statuses[-1]["progress"] == 100


@pytest.mark.anyio
async def test_generate_without_forge_progress_still_finishes(system, monkeypatch):
    """AI เครื่องเก่าที่ยังไม่มี /generate/progress หรือ Forge ไม่ตอบ → ไม่มี % แต่ภาพต้องออก"""
    def down(*a, **k):
        raise requests.ConnectionError("refused")
    monkeypatch.setattr(requests, "get", down)
    monkeypatch.setattr(backend, "PROGRESS_POLL_SEC", 0.05)
    async with client() as c:
        a = await login(c, "p3@example.com")
        j = (await c.post("/api/v1/jobs/generate", json={"prompt": "x"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])
        await asyncio.sleep(0.2)
        job = backend.JOBS[j["job_id"]]
        assert job.progress is None
        snap = backend._snapshot(job)
        assert "progress" not in snap
        assert "elapsed_sec" not in snap, "ค่าที่เปลี่ยนตลอดเวลาทำให้ SSE ส่งซ้ำไม่หยุด"
        system["release"].set()
        await wait_until(lambda: job.status == "done", timeout=10)


def test_image_job_gets_time_estimate_fields(monkeypatch):
    """งานแต่งภาพไม่มี % จริง → มี elapsed_sec และ avg_sec (เมื่อมีสถิติแล้ว) ให้หน้าเว็บประมาณเอง"""
    import time
    monkeypatch.setitem(backend.DURATIONS, "remove-background", deque([4.0, 6.0]))
    job = backend.Job.__new__(backend.Job)
    job.name, job.started, job.progress, job.eta_sec = "remove-background", time.time() - 2, None, None
    info = backend._progress_info(job)
    assert info["avg_sec"] == 5.0
    assert 1.5 <= info["elapsed_sec"] <= 3
    assert "progress" not in info


def test_no_fake_average_before_any_stats(monkeypatch):
    """ยังไม่เคยรันสักครั้ง → ไม่ส่ง avg_sec (หน้าเว็บใช้ค่าประมาณของตัวเอง ไม่ใช่ 10 วิ)"""
    monkeypatch.setattr(backend, "DURATIONS", {})
    job = backend.Job.__new__(backend.Job)
    job.name, job.started, job.progress, job.eta_sec = "generate", None, None, None
    assert "avg_sec" not in backend._progress_info(job)
