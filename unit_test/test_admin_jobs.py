"""
ทดสอบ: แดชบอร์ดงานใน Staff Console  —  GET /api/v1/admin/jobs

- ต้องเป็นเจ้าหน้าที่ (staff) เท่านั้น
- เห็นว่าใคร (ชื่อ + อีเมล) กำลังทำงานอะไร สถานะอะไร อยู่คิวที่เท่าไหร่
- งานที่จบแล้วย้ายไปอยู่ใน recent
- ไม่ส่งไฟล์ภาพ/ผลลัพธ์ออกมา
"""
import asyncio
import sqlite3

import pytest

import mainBackend as backend
from test_queue_lanes import anyio_backend, client, login, png, system, wait_until  # noqa: F401


def make_staff(email):
    conn = sqlite3.connect(backend.DB)
    conn.execute("UPDATE users SET role='staff' WHERE email=?", (email,))
    conn.commit()
    conn.close()


@pytest.mark.anyio
async def test_only_staff_can_see_jobs(system):
    async with client() as c:
        assert (await c.get("/api/v1/admin/jobs")).status_code == 401
        u = await login(c, "normal@example.com")
        assert (await c.get("/api/v1/admin/jobs", headers=u)).status_code == 403


@pytest.mark.anyio
async def test_dashboard_shows_who_is_doing_what(system):
    async with client() as c:
        boss = await login(c, "boss@example.com")
        make_staff("boss@example.com")
        a = await login(c, "alice@example.com")
        b = await login(c, "bob@example.com")
        d = await login(c, "dave@example.com")

        j1 = (await c.post("/api/v1/jobs/generate", json={"prompt": "a red fox", "size": "512x768"},
                           headers=a)).json()
        await wait_until(lambda: system["forge_calls"])
        j2 = (await c.post("/api/v1/jobs/generate", json={"prompt": "a cat"}, headers=b)).json()

        r = await c.get("/api/v1/admin/jobs", headers=boss)
        assert r.status_code == 200, r.text
        data = r.json()

        assert data["lanes"]["gen"]["running"] == 1
        assert data["lanes"]["gen"]["waiting"] == 1
        assert data["lanes"]["img"] == {**data["lanes"]["img"], "running": 0, "waiting": 0}

        active = {x["job_id"]: x for x in data["active"]}
        assert list(active) == [j1["job_id"], j2["job_id"]], "ต้องเรียงตามลำดับคิว"

        run = active[j1["job_id"]]
        assert run["user"] == {"email": "alice@example.com", "name": "alice@example.com"}
        assert run["tool"] == "generate" and run["lane"] == "gen"
        assert run["status"] == "running"
        assert run["started_at"] and run["run_sec"] is not None
        assert run["options"]["prompt"] == "a red fox"

        wait = active[j2["job_id"]]
        assert wait["status"] == "queued" and wait["position"] == 1
        assert wait["user"]["email"] == "bob@example.com"
        assert wait["started_at"] is None and wait["run_sec"] is None

        assert "result" not in str(data), "ห้ามส่งผลลัพธ์ภาพออกมาในแดชบอร์ด"

        # งานแต่งภาพของอีกคน จบเร็ว -> ย้ายไป recent
        j3 = (await c.post("/api/v1/jobs/remove-background",
                           files={"image": ("p.png", png(), "image/png")},
                           data={"output": "white"}, headers=d)).json()
        await wait_until(lambda: backend.JOBS[j3["job_id"]].status == "done")
        data = (await c.get("/api/v1/admin/jobs", headers=boss)).json()
        recent = {x["job_id"]: x for x in data["recent"]}
        assert j3["job_id"] in recent and j3["job_id"] not in {x["job_id"] for x in data["active"]}
        assert recent[j3["job_id"]]["status"] == "done"
        assert recent[j3["job_id"]]["tool"] == "remove-background"
        assert recent[j3["job_id"]]["options"].get("output") == "white"
        assert recent[j3["job_id"]]["finished_at"]

        system["release"].set()
        await wait_until(lambda: backend.JOBS[j2["job_id"]].status == "done", timeout=10)
        data = (await c.get("/api/v1/admin/jobs", headers=boss)).json()
        assert data["active"] == []
        assert {j1["job_id"], j2["job_id"], j3["job_id"]} <= {x["job_id"] for x in data["recent"]}
