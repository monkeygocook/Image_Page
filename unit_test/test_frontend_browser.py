"""
ทดสอบ: หน้าเว็บจริงในเบราว์เซอร์ (Image_index: script.js + api.js + eta.js)

เปิด proxy.py เป็นเว็บเซิร์ฟเวอร์จริงบนพอร์ตว่าง แล้วให้ Chromium (Playwright) กดเหมือนผู้ใช้
    เบราว์เซอร์ → proxy.py → mainBackend.py → mainAI.py → Forge จำลอง
ทั้งหมดอยู่ในโปรเซสเดียว ไม่ต้องเปิดเครื่องอื่น

ต้องติดตั้ง:  pip install playwright  แล้ว  python -m playwright install chromium
ไม่มี Playwright จะข้ามทั้งไฟล์   ·   รันเฉพาะไฟล์นี้:  pytest unit_test -m browser
"""
import asyncio
import base64
import io
import socket
import threading
import time

import httpx
import pytest
import requests
import uvicorn
from PIL import Image

import mainBackend as backend
import proxy
from conftest import ROOT

sync_api = pytest.importorskip("playwright.sync_api", reason="ยังไม่ได้ติดตั้ง playwright")
pytestmark = pytest.mark.browser

FORGE_SEC = 3.0


def png(color=(90, 140, 200), size=(512, 768)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def site(db_path, ai_main, monkeypatch):
    """เว็บจริงบน http://127.0.0.1:<port>  + Forge จำลองที่วาด FORGE_SEC วินาที"""
    forge = {"t0": None, "calls": 0, "hold": threading.Event()}
    forge["hold"].set()

    class Reply:
        status_code = 200
        text = ""
        def __init__(self, data): self._d = data
        def raise_for_status(self): pass
        def json(self): return self._d

    def fake_post(url, json=None, timeout=None, **kw):
        forge["calls"] += 1
        forge["t0"] = time.time()
        end = time.time() + FORGE_SEC
        while time.time() < end or not forge["hold"].is_set():
            time.sleep(0.05)
        forge["t0"] = None
        return Reply({"images": [base64.b64encode(png()).decode()]})

    def fake_get(url, params=None, timeout=None, **kw):
        if forge["t0"] is None:
            return Reply({"progress": 0.0, "eta_relative": 0.0, "state": {"job_count": 0}})
        p = min((time.time() - forge["t0"]) / FORGE_SEC, 0.99)
        return Reply({"progress": p, "eta_relative": FORGE_SEC * (1 - p),
                      "state": {"job_count": 1, "sampling_step": int(p * 20), "sampling_steps": 20}})

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(ai_main, "apply_filter", lambda *a, **k: png((10, 10, 10), (64, 64)))

    # คิว/condition ใหม่ (ผูกกับ event loop ของเซิร์ฟเวอร์ในเธรดนี้)
    monkeypatch.setattr(backend, "LANES", {"gen": backend.Lane(1, 10), "img": backend.Lane(1, 10)})
    monkeypatch.setattr(backend, "_cond", asyncio.Condition())
    monkeypatch.setattr(backend, "PROGRESS_POLL_SEC", 0.3)
    monkeypatch.setattr(ai_main, "_job_slots",
                        {lane: asyncio.Semaphore(c) for lane, (c, _) in ai_main.LANE_LIMITS.items()})
    monkeypatch.setattr(ai_main, "_pending_jobs", {lane: 0 for lane in ai_main.LANE_LIMITS})
    monkeypatch.setattr(backend, "_ai_client", httpx.AsyncClient(
        transport=httpx.ASGITransport(app=ai_main.app), base_url="http://ai.test", timeout=60))

    # backend ต้องเป็นเซิร์ฟเวอร์จริงด้วย — httpx.ASGITransport รอ response ครบก่อน จึงสตรีม SSE ไม่ได้
    be_port = free_port()
    be = serve(backend.app, be_port)
    monkeypatch.setattr(proxy, "client", httpx.AsyncClient(
        base_url=f"http://127.0.0.1:{be_port}", timeout=60))

    port = free_port()
    web = serve(proxy.build(ROOT / "Image_index"), port)
    yield {"url": f"http://127.0.0.1:{port}/", "forge": forge}
    forge["hold"].set()
    for srv, th in (web, be):
        srv.should_exit = True
        th.join(5)


def serve(app, port):
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                        log_level="warning", lifespan="off"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    return srv, th


@pytest.fixture
def page(site):
    with sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:
            pytest.skip(f"เปิด Chromium ไม่ได้: {exc}")
        pg = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(site["url"])
        pg.wait_for_selector("#authModal:not([hidden])", timeout=5000)
        pg.click("#authSwitch")
        pg.fill("#authName", "Browser")
        pg.fill("#authEmail", "browser@example.com")
        pg.fill("#authPass", "Password123")
        pg.click("#authSubmit")
        pg.wait_for_selector("#authModal", state="hidden", timeout=5000)
        pg.js_errors = errors
        yield pg
        browser.close()


def button_text(pg):
    return pg.inner_text("#submitBtn").strip()


def bar_width(pg):
    return pg.evaluate("() => { const e = document.querySelector('.eta-btn-bar');"
                       " return e ? (parseFloat(e.style.width) || 0) : null; }")


# ---------------------------------------------------------------- สร้างภาพ + แถบ %

def test_generate_shows_progress_then_result(page, site):
    cta = button_text(page)
    page.fill("#promptInput", "a blue sky")
    page.click("#submitBtn")

    seen = []
    t0 = time.time()
    while time.time() - t0 < FORGE_SEC + 8:
        txt = button_text(page)
        w = bar_width(page)
        if w is not None:
            seen.append((txt, w))
        if txt == cta and seen:
            break
        page.wait_for_timeout(200)

    pcts = [w for _, w in seen]
    assert seen, "ไม่เห็นแถบ % บนปุ่มเลย (eta.js ไม่ทำงาน)"
    assert any("%" in t for t, _ in seen), f"ข้อความบนปุ่มไม่มี %: {seen[:5]}"
    assert max(pcts) > 30, f"แถบไม่ขยับ: {pcts}"
    assert pcts == sorted(pcts), f"แถบถอยหลัง: {pcts}"

    page.wait_for_selector("#soloImage:not([hidden])", timeout=5000)
    assert page.get_attribute("#soloImage", "src").startswith("blob:")
    assert button_text(page) == cta, "ปุ่มไม่กลับเป็นข้อความเดิมหลังเสร็จ"
    assert not page.is_disabled("#submitBtn")
    assert page.js_errors == [], page.js_errors


def test_cancel_restores_button_and_cancels_job(page, site):
    cta = button_text(page)
    site["forge"]["hold"].clear()                 # ให้ Forge ค้างไว้จนกว่าจะปล่อย
    page.fill("#promptInput", "a long job")
    page.click("#submitBtn")
    page.wait_for_selector("#btnCancel:not([hidden])", timeout=5000)
    page.wait_for_function("() => document.querySelector('.eta-btn-bar') !== null", timeout=5000)

    page.click("#btnCancel")
    page.wait_for_function(f"() => document.getElementById('submitBtn').innerText.trim() === {cta!r}",
                           timeout=5000)
    assert page.is_hidden("#btnCancel")
    assert page.inner_text("#hint").strip() in ("ยกเลิกแล้ว", "Cancelled")
    assert page.is_hidden("#soloImage")

    # งานใน backend ต้องถูกยกเลิกจริง (ผู้ใช้ส่งงานใหม่ได้)
    t0 = time.time()
    while time.time() - t0 < 5:
        if not any(backend.JOBS[i].status in ("queued", "running")
                   for i in backend.LANES["gen"].queue if i in backend.JOBS):
            break
        time.sleep(0.1)
    assert backend.LANES["gen"].queue == [], "กดยกเลิกแล้วงานยังค้างอยู่ในคิว"
    site["forge"]["hold"].set()
    assert page.js_errors == [], page.js_errors


# ---------------------------------------------------------------- งานแต่งภาพ (ไม่มี % จริง)

def test_image_tool_with_upload(page, site):
    page.click(".tab[data-tab='tone']")
    cta = button_text(page)
    page.set_input_files("#fileInput", files=[{"name": "photo.png", "mimeType": "image/png",
                                               "buffer": png((200, 50, 50), (64, 64))}])
    page.wait_for_selector("#filePreview:not([hidden])", timeout=5000)
    page.click("#submitBtn")
    page.wait_for_function(
        "() => !document.getElementById('compareWrap').hidden || !document.getElementById('soloImage').hidden",
        timeout=8000)
    page.wait_for_function(f"() => document.getElementById('submitBtn').innerText.trim() === {cta!r}",
                           timeout=5000)
    assert page.js_errors == [], page.js_errors


# ---------------------------------------------------------------- eta.js ฟังก์ชันล้วน

def test_eta_percent_curve(page):
    vals = page.evaluate("""() => [0, 2.5, 5, 9, 10, 15, 60, 600].map(s => Eta.percent(s, 10))""")
    assert vals[0] == 0
    assert abs(vals[2] - 50) < 0.01
    assert vals == sorted(vals), f"% ต้องไม่ลดลงตามเวลา: {vals}"
    assert max(vals) <= 99, "ยังไม่เสร็จต้องไม่ถึง 100%"


def test_eta_wraps_process_job(page):
    assert page.evaluate("() => typeof Eta === 'object' && typeof Api.image.processJob === 'function'")
    # ตัวครอบของ eta.js ต้องเป็นตัวที่ script.js เรียก (ไม่ใช่ processJob ตัวเดิมของ api.js)
    src = page.evaluate("() => Api.image.processJob.toString()")
    assert "Eta.track" in src, "eta.js ไม่ได้ครอบ Api.image.processJob — แถบ % จะไม่ขึ้น"


def test_button_never_shows_queue_position_zero(page, site):
    """ตอนคิวว่าง งานเริ่มทันที — ปุ่มไม่ควรขึ้น 'คิวที่ 0 จาก 1'"""
    cta = button_text(page)
    page.fill("#promptInput", "quick")
    page.evaluate("""() => {
        window.__texts = [];
        const btn = document.getElementById('submitBtn');
        new MutationObserver(() => window.__texts.push(btn.innerText.trim()))
            .observe(btn, {subtree: true, childList: true, characterData: true});
    }""")
    page.click("#submitBtn")
    page.wait_for_function(f"() => document.getElementById('submitBtn').innerText.trim() === {cta!r}",
                           timeout=FORGE_SEC * 1000 + 8000)
    texts = page.evaluate("() => window.__texts")
    bad = [t for t in texts if "คิวที่ 0" in t or "Queue 0" in t]
    assert not bad, (
        f"ปุ่มขึ้น {bad[0]!r} — POST /api/v1/jobs ตอบ status=queued position=0 ก่อนเริ่มรัน "
        "แล้ว eta.js แสดงตามนั้น (ควรแสดง 'กำลังส่ง...' เมื่อ position < 1)"
    )
