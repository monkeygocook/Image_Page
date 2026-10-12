/* =============================================================
   eta.js — แถบเปอร์เซ็นต์ความคืบหน้า บนปุ่มสีส้ม (#submitBtn)

   ข้อมูลมาจากสถานะงานที่ backend ส่งผ่าน SSE (/api/v1/jobs/{id}/events)
     queued  : position / total            → "คิวที่ 2 จาก 3" + แถบวิ่ง
     running : progress (0–100) / eta_sec  → % จริงจาก Forge (เฉพาะสร้างภาพ)
               elapsed_sec / avg_sec       → % ประมาณจากเวลา (งานแต่งภาพ
                                             หรือเมื่อ Forge ไม่ตอบ)
     done    : progress = 100
   ============================================================= */

const Eta = (() => {
    const KEY = "eta:actual_durations";
    const KEEP = 5;
    const MAX_SEC = 330;                 // ตรงกับ PROCESS_TIMEOUT
    const TICK_MS = 250;
    const DEFAULTS = { genimage: 90, back: 15, icon: 5, tone: 5, blur: 8 };
    const FALLBACK = 15;

    /* ---------- สถิติเวลาประมวลผลจริงในเครื่องนี้ (สำรอง ถ้า backend ยังไม่มีสถิติ) ---------- */
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

    /* ---------- ข้อความ (ใช้ t() ของ script.js ถ้ามี) ---------- */
    const FALLBACK_TEXT = {
        "eta.sending": "กำลังส่ง...",
        "eta.queue": "คิวที่ {n} จาก {total} · รอมา {time}",
        "eta.leftMin": "เหลือ ~{n} นาที",
        "eta.leftSec": "เหลือ ~{n} วิ",
        "eta.almost": "ใกล้เสร็จแล้ว...",
        "eta.slow": "นานกว่าปกติ...",
    };
    function tr(k, vars = {}) {
        const s = typeof t === "function" ? t(k, vars) : null;
        if (s && s !== k) return s;
        return FALLBACK_TEXT[k].replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");
    }

    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    function remainText(remain) {
        if (remain == null) return "";
        if (remain >= 90) return tr("eta.leftMin", { n: Math.ceil(remain / 60) });
        if (remain >= 1) return tr("eta.leftSec", { n: Math.ceil(remain) });
        if (remain > -3) return tr("eta.almost");
        return tr("eta.slow");
    }

    // % ประมาณจากเวลา: วิ่งตามจริงถึง 90% แล้วค่อย ๆ ชะลอ ไม่เกิน 99% จนกว่างานจะเสร็จ
    function percent(elapsed, est) {
        const r = elapsed / est;
        const p = r < 0.9 ? r * 100 : 90 + 9 * (1 - Math.exp(-(r - 0.9) * 4));
        return Math.min(p, 99);
    }

    /* ---------- ครอบงาน 1 ครั้ง ----------
       run(onStatus) ต้องเรียก onStatus(สถานะจาก backend) ทุกครั้งที่สถานะเปลี่ยน */
    async function track(tab, run) {
        const btn = document.getElementById("submitBtn");
        if (!btn) { console.warn("[eta] ไม่พบปุ่ม #submitBtn"); return run(() => { }); }

        const saved = btn.innerHTML;
        const t0 = performance.now();
        const st = {
            phase: "send",               // send → queue → work → done
            position: 0, total: 0,
            est: getEstimate(tab),       // วินาทีที่คาดว่าจะใช้ประมวลผล
            workStart: t0,
            real: null,                  // % จริงจาก Forge (null = ยังไม่มี)
            realEta: null, realAt: 0,
            shown: 0,                    // % ที่แสดงอยู่ (กันแถบถอยหลัง)
        };

        btn.classList.add("eta-running");
        btn.innerHTML = '<span class="eta-btn-bar"></span><span class="eta-btn-label"></span>';
        const label = btn.querySelector(".eta-btn-label");
        const bar = btn.querySelector(".eta-btn-bar");

        function onStatus(s) {
            if (!s || !s.status) return;
            const now = performance.now();
            if (s.status === "queued") {
                st.phase = "queue";
                st.position = s.position || 0;
                st.total = s.total || 0;
            } else if (s.status === "running") {
                if (st.phase !== "work") {
                    st.phase = "work";
                    st.workStart = now - (Number(s.elapsed_sec) || 0) * 1000;
                    st.shown = 0;
                }
                if (Number(s.avg_sec) > 0) st.est = Number(s.avg_sec);   // สถิติของเซิร์ฟเวอร์แม่นกว่า
                if (typeof s.progress === "number") {
                    // ครั้งแรกที่ได้ % จริง ให้แทนค่าประมาณเลย (อาจลดลงได้ 1 ครั้ง)
                    if (st.real == null) st.shown = 0;
                    st.real = s.progress;
                    st.realEta = typeof s.eta_sec === "number" ? s.eta_sec : null;
                    st.realAt = now;
                }
            } else if (s.status === "done") {
                st.phase = "done";
            }
            tick();
        }

        function tick() {
            const now = performance.now();
            btn.classList.toggle("eta-queued", st.phase === "queue" || st.phase === "send");

            if (st.phase === "send") {
                label.textContent = tr("eta.sending");
                return;
            }
            if (st.phase === "queue") {
                label.textContent = tr("eta.queue", {
                    n: st.position, total: st.total || st.position, time: clock((now - t0) / 1000),
                });
                return;
            }

            let pct, remain;
            if (st.phase === "done") {
                pct = 100; remain = null;
            } else {
                const elapsed = (now - st.workStart) / 1000;
                if (st.real != null) {
                    pct = st.real;
                    remain = st.realEta != null ? st.realEta - (now - st.realAt) / 1000 : null;
                } else {
                    pct = percent(elapsed, st.est);
                    remain = st.est - elapsed;
                }
            }
            st.shown = Math.max(st.shown, pct);
            const p = Math.floor(st.shown);
            const r = remainText(remain);
            label.textContent = r ? `${p}% · ${r}` : `${p}%`;
            bar.style.width = st.shown.toFixed(1) + "%";
        }

        tick();
        const loop = setInterval(tick, TICK_MS);

        try {
            const out = await run(onStatus);
            if (st.phase === "work" || st.phase === "done") {
                recordTime(tab, (performance.now() - st.workStart) / 1000);
            }
            return out;
        } finally {
            clearInterval(loop);
            btn.classList.remove("eta-running", "eta-queued");
            if (btn.contains(label)) btn.innerHTML = saved;
        }
    }

    return { track, getEstimate, percent };
})();

/* ---------- ครอบ Api.image.processJob ---------- */
(() => {
    if (typeof Api === "undefined" || typeof Api?.image?.processJob !== "function") {
        console.warn("[eta] ไม่พบ Api.image.processJob — eta.js ต้องโหลดหลัง api.js");
        return;
    }
    const original = Api.image.processJob;
    Api.image.processJob = function (args = {}) {
        return Eta.track(args.tab || "default", (etaStatus) =>
            original.call(this, {
                ...args,
                onStatus: (s) => { etaStatus(s); args.onStatus?.(s); },
            })
        );
    };
    console.info("[eta] พร้อมใช้งาน");
})();
