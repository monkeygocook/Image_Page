/* =============================================================
   eta.js — แสดงเวลาถอยหลังบนปุ่มสีส้ม (#submitBtn)
   ประมาณจากเวลาจริง: มัธยฐาน 5 ครั้งล่าสุดของแต่ละแท็บ
   ============================================================= */

const Eta = (() => {
    const KEY = "eta:actual_durations";
    const KEEP = 5;
    const MAX_SEC = 330;                 // ตรงกับ PROCESS_TIMEOUT
    const TICK_MS = 250;
    const DEFAULTS = { genimage: 90, back: 15, icon: 5, tone: 5, blur: 8 };
    const FALLBACK = 15;

    /* ---------- สถิติ ---------- */
    const load = () => {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch { return {}; }
    };

    function getEstimate(tab) {
        const xs = load()[tab];
        if (!Array.isArray(xs) || !xs.length) return DEFAULTS[tab] ?? FALLBACK;
        const s = [...xs].sort((a, b) => a - b);
        return Math.max(s[Math.floor(s.length / 2)], 1);
    }

    function recordTime(tab, sec) {
        if (!(sec > 0 && sec <= MAX_SEC)) return;
        const all = load();
        all[tab] = [...(all[tab] || []), Math.round(sec * 10) / 10].slice(-KEEP);
        try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { }
    }

    /* ---------- ข้อความ ---------- */
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    function message(remain) {
        if (remain >= 90) return `เหลือ ~${Math.ceil(remain / 60)} นาที`;
        if (remain >= 1) return `เหลือ ~${Math.ceil(remain)} วิ`;     // นับถอยหลังได้ถึง 1 วิ
        if (remain > -3) return "ใกล้เสร็จแล้ว...";
        return "ใช้เวลานานกว่าปกติ...";
    }

    function percent(elapsed, est) {
        const r = elapsed / est;
        const p = r < 0.9 ? r * 100 : 90 + 9 * (1 - Math.exp(-(r - 0.9) * 4));
        return Math.min(p, 99);
    }

    /* ---------- ครอบงาน 1 ครั้ง ---------- */
    async function track(tab, run) {
        const btn = document.getElementById("submitBtn");
        if (!btn) { console.warn("[eta] ไม่พบปุ่ม #submitBtn"); return run(); }

        const saved = btn.innerHTML;
        const est = getEstimate(tab);
        const t0 = performance.now();

        // สร้างโครงครั้งเดียว แล้วอัปเดตเฉพาะข้อความและความกว้าง
        btn.classList.add("eta-running");
        btn.innerHTML = '<span class="eta-btn-label"></span><span class="eta-btn-bar"></span>';
        const label = btn.querySelector(".eta-btn-label");
        const bar = btn.querySelector(".eta-btn-bar");

        const tick = () => {
            const s = (performance.now() - t0) / 1000;
            label.textContent = `${message(est - s)} · ${clock(s)}`;
            bar.style.width = percent(s, est).toFixed(1) + "%";
        };
        tick();                                   // แสดงทันทีตอนกด ไม่ต้องรอรอบแรก
        const loop = setInterval(tick, TICK_MS);

        try {
            const out = await run();
            recordTime(tab, (performance.now() - t0) / 1000);   // บันทึกเฉพาะรอบที่สำเร็จ
            return out;
        } finally {
            clearInterval(loop);
            btn.classList.remove("eta-running");
            // คืนข้อความเดิม เฉพาะกรณีที่ยังไม่มีใครเปลี่ยนปุ่ม (เช่น สลับแท็บระหว่างรอ)
            if (btn.contains(label)) btn.innerHTML = saved;
        }
    }

    return { track, getEstimate };
})();

/* ---------- ครอบ Api.image.process โดยไม่แก้ api.js ---------- */
(() => {
    if (typeof Api === "undefined" || typeof Api?.image?.process !== "function") {
        console.warn("[eta] ไม่พบ Api.image.process — eta.js ต้องโหลดหลัง api.js");
        return;
    }
    const original = Api.image.process;
    Api.image.process = function (args = {}) {
        return Eta.track(args.tab || "default", () => original.call(this, args));
    };
    if (Api.image.process === original) console.warn("[eta] ครอบ Api.image.process ไม่สำเร็จ");
    else console.info("[eta] พร้อมใช้งาน");
})();