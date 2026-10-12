/* =============================================================
   eta.js — แถบคิว + เวลาที่เหลือ บนปุ่มสีส้ม (#submitBtn)
   ช่วงที่ 1 รอคิว   : ลำดับคิวจาก backend (GET /api/v1/queue/{id})
   ช่วงที่ 2 ประมวลผล : เวลาที่เหลือ ประมาณจากเวลาประมวลผลจริง
   ============================================================= */

const Eta = (() => {
    // เปลี่ยนเป็น true เมื่อปั้นเปิด endpoint คิวแล้ว
    const QUEUE_ENABLED = false;

    const KEY = "eta:actual_durations";
    const KEEP = 5;
    const MAX_SEC = 330;                 // ตรงกับ PROCESS_TIMEOUT
    const TICK_MS = 250;
    const POLL_MS = 1000;                // ถามคิวทุก 1 วินาที
    const MAX_MISS = 3;                  // ถามแล้วไม่ได้ข้อมูลเลย 3 ครั้ง = ข้ามไปแสดงเวลาแทน
    const QUEUE_URL = (id) => `/api/v1/queue/${encodeURIComponent(id)}`;
    const DEFAULTS = { genimage: 90, back: 15, icon: 5, tone: 5, blur: 8 };
    const FALLBACK = 15;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ---------- สถิติเวลาประมวลผลจริง (ไม่รวมเวลารอคิว) ---------- */
    const load = () => {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch { return {}; }
    };

    function getEstimate(tab) {
        const xs = load()[tab];
        if (!Array.isArray(xs) || !xs.length) return DEFAULTS[tab] ?? FALLBACK;
        const s = [...xs].sort((a, b) => a - b);
        return Math.max(s[Math.floor(s.length / 2)], 1);       // มัธยฐาน
    }

    function recordTime(tab, sec) {
        if (!(sec > 0 && sec <= MAX_SEC)) return;
        const all = load();
        all[tab] = [...(all[tab] || []), Math.round(sec * 10) / 10].slice(-KEEP);
        try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { }
    }

    /* ---------- รหัสคำขอ (ใช้ผูกคำขอกับข้อมูลคิว) ---------- */
    function newId() {
        // randomUUID ใช้ไม่ได้ถ้าเปิดผ่าน http ด้วย IP ในวง LAN จึงต้องมีทางสำรอง
        return globalThis.crypto?.randomUUID?.()
            || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
    }

    // ⚠️ ต้องตรงกับที่ api.js เก็บ token ไว้ (ดู FE-79)
    function authHeader() {
        const t = localStorage.getItem("token");
        return t ? { Authorization: "Bearer " + t } : {};
    }

    async function fetchQueue(id) {
        try {
            const res = await fetch(QUEUE_URL(id), { headers: authHeader(), cache: "no-store" });
            return res.ok ? await res.json() : null;
        } catch { return null; }
    }

    /* ---------- ข้อความ ---------- */
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    function message(remain) {
        if (remain >= 90) return `เหลือ ~${Math.ceil(remain / 60)} นาที`;
        if (remain >= 1) return `เหลือ ~${Math.ceil(remain)} วิ`;
        if (remain > -3) return "ใกล้เสร็จแล้ว...";
        return "ใช้เวลานานกว่าปกติ...";
    }

    function percent(elapsed, est) {
        const r = elapsed / est;
        const p = r < 0.9 ? r * 100 : 90 + 9 * (1 - Math.exp(-(r - 0.9) * 4));
        return Math.min(p, 99);
    }

    /* ---------- ครอบงาน 1 ครั้ง ---------- */
    async function track(tab, run, requestId) {
        const btn = document.getElementById("submitBtn");
        if (!btn) { console.warn("[eta] ไม่พบปุ่ม #submitBtn"); return run(); }

        const saved = btn.innerHTML;
        const t0 = performance.now();
        let est = getEstimate(tab);
        let phase = QUEUE_ENABLED && requestId ? "queue" : "work";
        let tWork = t0;                  // เวลาที่เริ่มประมวลผลจริง
        let queue = null;
        let finished = false;

        btn.classList.add("eta-running");
        btn.classList.toggle("eta-queued", phase === "queue");
        btn.innerHTML = '<span class="eta-btn-label"></span><span class="eta-btn-bar"></span>';
        const label = btn.querySelector(".eta-btn-label");
        const bar = btn.querySelector(".eta-btn-bar");

        function startWork(serverAvg, from = performance.now()) {
            phase = "work";
            tWork = from;
            if (serverAvg > 0) est = serverAvg;    // ค่าเฉลี่ยจากเซิร์ฟเวอร์แม่นกว่า ใช้ก่อน
            btn.classList.remove("eta-queued");
            bar.style.width = "0";
        }

        const tick = () => {
            const now = performance.now();
            if (phase === "queue") {
                const waited = clock((now - t0) / 1000);
                label.textContent = queue?.position > 0
                    ? `อยู่คิวที่ ${queue.position}${queue.total ? ` จาก ${queue.total}` : ""} · รอมาแล้ว ${waited}`
                    : `กำลังเข้าคิว... · ${waited}`;
                return;
            }
            const s = (now - tWork) / 1000;
            label.textContent = `${message(est - s)} · ${clock(s)}`;
            bar.style.width = percent(s, est).toFixed(1) + "%";
        };

        async function watchQueue() {
            let misses = 0;
            while (!finished && phase === "queue") {
                const info = await fetchQueue(requestId);
                if (finished) return;
                if (!info) {
                    // ยังไม่เคยได้ข้อมูลคิวเลย: ข้ามไปแสดงเวลา โดยนับจากตอนกดปุ่ม
                    if (!queue && ++misses >= MAX_MISS) { startWork(0, t0); return; }
                } else if (info.state === "queued") {
                    queue = info;
                } else if (info.state === "processing") {
                    startWork(Number(info.avg_process_sec)); return;
                } else {
                    return;                             // done / failed: รอผลจากคำขอหลัก
                }
                tick();
                await sleep(POLL_MS);
            }
        }

        tick();
        const loop = setInterval(tick, TICK_MS);
        if (phase === "queue") watchQueue();

        try {
            const out = await run();
            // บันทึกเฉพาะเวลาที่รู้แน่ว่าเป็นช่วงประมวลผล
            if (phase === "work") recordTime(tab, (performance.now() - tWork) / 1000);
            return out;
        } finally {
            finished = true;
            clearInterval(loop);
            btn.classList.remove("eta-running", "eta-queued");
            if (btn.contains(label)) btn.innerHTML = saved;
        }
    }

    return { track, newId, getEstimate };
})();

/* ---------- ครอบ Api.image.process ---------- */
(() => {
    if (typeof Api === "undefined" || typeof Api?.image?.process !== "function") {
        console.warn("[eta] ไม่พบ Api.image.process — eta.js ต้องโหลดหลัง api.js");
        return;
    }
    const original = Api.image.process;
    Api.image.process = function (args = {}) {
        const requestId = args.requestId || Eta.newId();
        return Eta.track(
            args.tab || "default",
            () => original.call(this, { ...args, requestId }),
            requestId
        );
    };
    console.info("[eta] พร้อมใช้งาน");
})();