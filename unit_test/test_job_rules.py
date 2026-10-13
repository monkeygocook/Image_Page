"""
ทดสอบ: กติกาของงาน (jobs) ใน backend

- งานของใครของคนนั้น: คนอื่นดูสถานะ / ดึงภาพ / ยกเลิก ไม่ได้      (รูปของผู้ใช้เป็นข้อมูลส่วนตัว)
- 1 คน 1 งานต่อครั้ง (JOB_ACTIVE)
- งานที่จบเกิน JOB_TTL ถูกล้างออกจากหน่วยความจำ ไม่ให้ backend กินแรมขึ้นเรื่อย ๆ
"""
import asyncio
import time

import pytest

import mainBackend as backend
from test_queue_lanes import anyio_backend, client, login, png, system, wait_until  # noqa: F401


# ---------------------------------------------------------------- งานของใครของคนนั้น

@pytest.mark.anyio
async def test_other_user_cannot_touch_my_job(system):
    async with client() as c:
        owner = await login(c, "owner@example.com")
        other = await login(c, "other@example.com")

        j = (await c.post("/api/v1/jobs/generate", json={"prompt": "secret"}, headers=owner)).json()
        jid = j["job_id"]
        await wait_until(lambda: system["forge_calls"])

        for method, path in [("GET", f"/api/v1/jobs/{jid}"),
                             ("GET", f"/api/v1/jobs/{jid}/result"),
                             ("GET", f"/api/v1/jobs/{jid}/events"),
                             ("GET", f"/api/v1/queue/{jid}"),
                             ("DELETE", f"/api/v1/jobs/{jid}")]:
            r = await c.request(method, path, headers=other)
            assert r.status_code == 404, f"{method} {path} → {r.status_code} (คนอื่นเข้าถึงงานนี้ได้)"

        assert backend.JOBS[jid].status == "running", "คนอื่นยกเลิกงานของเราได้"

        system["release"].set()
        await wait_until(lambda: backend.JOBS[jid].status == "done", timeout=10)

        r = await c.get(f"/api/v1/jobs/{jid}/result", headers=other)
        assert r.status_code == 404, "คนอื่นดึงภาพผลลัพธ์ของเราได้"
        r = await c.get(f"/api/v1/jobs/{jid}/result", headers=owner)
        assert r.status_code == 200 and r.content.startswith(b"\x89PNG")


@pytest.mark.anyio
async def test_job_endpoints_need_login(system):
    async with client() as c:
        owner = await login(c, "solo@example.com")
        jid = (await c.post("/api/v1/jobs/remove-background",
                            files={"image": ("p.png", png(), "image/png")}, headers=owner)).json()["job_id"]
        for method, path in [("GET", f"/api/v1/jobs/{jid}"), ("GET", f"/api/v1/jobs/{jid}/result"),
                             ("DELETE", f"/api/v1/jobs/{jid}"), ("POST", "/api/v1/jobs/generate")]:
            r = await c.request(method, path)
            assert r.status_code == 401, f"{method} {path} → {r.status_code}"


@pytest.mark.anyio
async def test_result_before_done_is_not_ready(system):
    async with client() as c:
        a = await login(c, "early@example.com")
        jid = (await c.post("/api/v1/jobs/generate", json={"prompt": "x"}, headers=a)).json()["job_id"]
        await wait_until(lambda: system["forge_calls"])
        r = await c.get(f"/api/v1/jobs/{jid}/result", headers=a)
        assert r.status_code == 409 and r.json()["error"]["code"] == "NOT_READY"
        system["release"].set()


@pytest.mark.anyio
async def test_unknown_job_is_404(system):
    async with client() as c:
        a = await login(c, "ghost@example.com")
        assert (await c.get("/api/v1/jobs/does-not-exist", headers=a)).status_code == 404


@pytest.mark.anyio
async def test_unknown_tool_is_404(system):
    async with client() as c:
        a = await login(c, "tool@example.com")
        r = await c.post("/api/v1/jobs/teleport", json={}, headers=a)
        assert r.status_code == 404


# ---------------------------------------------------------------- 1 คน 1 งาน

@pytest.mark.anyio
async def test_one_job_per_user_at_a_time(system):
    async with client() as c:
        a = await login(c, "busy@example.com")
        b = await login(c, "free@example.com")

        j1 = (await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])

        # คนเดิมส่งงานที่สอง (ทั้งสายเดียวกันและอีกสาย) → 409
        r = await c.post("/api/v1/jobs/generate", json={"prompt": "two"}, headers=a)
        assert r.status_code == 409 and r.json()["error"]["code"] == "JOB_ACTIVE", r.text
        r = await c.post("/api/v1/jobs/remove-background",
                         files={"image": ("p.png", png(), "image/png")}, headers=a)
        assert r.status_code == 409 and r.json()["error"]["code"] == "JOB_ACTIVE", r.text
        # แบบ URL ตรง (ไม่ผ่าน /jobs) ก็ต้องโดนกติกาเดียวกัน
        r = await c.post("/api/v1/remove-background",
                         files={"image": ("p.png", png(), "image/png")}, headers=a)
        assert r.status_code == 409 and r.json()["error"]["code"] == "JOB_ACTIVE", r.text

        # อีกคนส่งได้ปกติ
        r = await c.post("/api/v1/jobs/remove-background",
                         files={"image": ("p.png", png(), "image/png")}, headers=b)
        assert r.status_code == 202, r.text

        # งานแรกจบแล้ว ส่งใหม่ได้
        system["release"].set()
        await wait_until(lambda: backend.JOBS[j1["job_id"]].status == "done", timeout=10)
        r = await c.post("/api/v1/jobs/remove-background",
                         files={"image": ("p.png", png(), "image/png")}, headers=a)
        assert r.status_code == 202, r.text


@pytest.mark.anyio
async def test_cancelled_job_frees_user_to_send_again(system):
    async with client() as c:
        a = await login(c, "cancel@example.com")
        j1 = (await c.post("/api/v1/jobs/generate", json={"prompt": "one"}, headers=a)).json()
        await wait_until(lambda: system["forge_calls"])
        assert (await c.delete(f"/api/v1/jobs/{j1['job_id']}", headers=a)).status_code == 204
        await wait_until(lambda: j1["job_id"] not in backend.LANES["gen"].queue)

        r = await c.post("/api/v1/jobs/remove-background",
                         files={"image": ("p.png", png(), "image/png")}, headers=a)
        assert r.status_code == 202, r.text
        system["release"].set()


@pytest.mark.anyio
async def test_duplicate_request_id_is_rejected(system):
    async with client() as c:
        a = await login(c, "dup@example.com")
        h = {**a, "X-Request-ID": "same-id-123"}
        r1 = await c.post("/api/v1/jobs/remove-background",
                          files={"image": ("p.png", png(), "image/png")}, headers=h)
        assert r1.status_code == 202 and r1.json()["job_id"] == "same-id-123"
        await wait_until(lambda: backend.JOBS["same-id-123"].status == "done")
        r2 = await c.post("/api/v1/jobs/remove-background",
                          files={"image": ("p.png", png(), "image/png")}, headers=h)
        assert r2.status_code == 409 and r2.json()["error"]["code"] == "DUPLICATE_REQUEST"


# ---------------------------------------------------------------- ล้างงานเก่า (JOB_TTL)

@pytest.mark.anyio
async def test_old_finished_jobs_are_cleaned_up(monkeypatch):
    now = time.time()
    jobs = {}
    for jid, finished in [("old", now - backend.JOB_TTL - 5),
                          ("fresh", now - 10),
                          ("running", None)]:
        j = backend.Job("x@example.com", "filter", jid)
        j.finished = finished
        j.result = b"x" * 1000
        jobs[jid] = j
    monkeypatch.setattr(backend, "JOBS", jobs)

    real_sleep = asyncio.sleep
    rounds = {"n": 0}

    async def fast_sleep(sec):
        rounds["n"] += 1
        if rounds["n"] > 1:
            raise asyncio.CancelledError     # รอบที่สอง: หยุดลูป
        await real_sleep(0)

    monkeypatch.setattr(backend.asyncio, "sleep", fast_sleep)
    await backend._job_gc()                  # สร้าง task ล้างงาน
    for _ in range(20):
        await real_sleep(0)
        if rounds["n"] > 1:
            break

    assert "old" not in backend.JOBS, "งานที่จบเกิน JOB_TTL ไม่ถูกล้าง"
    assert "fresh" in backend.JOBS, "งานที่เพิ่งจบถูกลบเร็วเกินไป (ผู้ใช้ยังดึงภาพไม่ทัน)"
    assert "running" in backend.JOBS, "งานที่ยังไม่จบถูกลบ"
