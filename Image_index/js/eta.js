/* =============================================================
   eta.js — แถบแสดงเวลาคาดการณ์ (วางตำแหน่งข้างปุ่มดำเนินการ)
   ============================================================= */

const Eta = (() => {
    const KEY = "eta:actual_durations";
    const KEEP = 5;
    const SHOW_AFTER = 400; // แสดงผลอย่างรวดเร็วเมื่อเริ่มประมวลผล
    const MAX_SEC = 330;

    const DEFAULTS = {
        genimage: 90,
        back: 15,
        icon: 5,
        tone: 5,
        blur: 8
    };
    const FALLBACK = 15;

    const load = () => {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch { return {}; }
    };

    function getEstimate(tab) {
        const history = load()[tab];
        if (!Array.isArray(history) || !history.length) return DEFAULTS[tab] ?? FALLBACK;
        const sorted = [...history].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    function recordTime(tab, seconds) {
        if (!(seconds > 0 && seconds <= MAX_SEC)) return;
        const data = load();
        data[tab] = [...(data[tab] || []), Math.round(seconds)].slice(-KEEP);
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { }
    }

    let box, textEl, trackEl, fillEl;

    function initUI() {
        if (box) return;
        box = document.createElement("div");
        box.className = "eta-inline-box";
        box.hidden = true;
        box.innerHTML = `
            <div class="eta-inline-content">
                <span class="eta-inline-text">กำลังประมวลผล...</span>
                <span class="eta-inline-time"></span>
            </div>
            <div class="eta-inline-track">
                <div class="eta-inline-fill"></div>
            </div>`;

        // ค้นหาตำแหน่งปุ่มส่งคำขอหรือปุ่มดาวน์โหลดเพื่อนำไปวางไว้ด้านข้าง
        const targetAnchor = document.getElementById("submitBtn") || document.getElementById("genForm") || document.body;
        if (targetAnchor && targetAnchor.parentNode) {
            targetAnchor.parentNode.insertBefore(box, targetAnchor.nextSibling);
        } else {
            document.body.appendChild(box);
        }

        textEl = box.querySelector(".eta-inline-time");
        fillEl = box.querySelector(".eta-inline-fill");
    }

    const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    function updateDisplay(remaining, elapsed, est) {
        let msg = "";
        if (remaining > 60) {
            msg = `เหลือ ~${Math.ceil(remaining / 60)} นาที`;
        } else if (remaining > 5) {
            msg = `เหลือ ~${Math.round(remaining)} วิ`;
        } else {
            msg = "ใกล้เสร็จแล้ว...";
        }
        if (textEl) {
            textEl.textContent = `${msg} (${formatTime(elapsed)})`;
        }

        const ratio = elapsed / est;
        const percent = ratio < 0.9 ? ratio * 90 : 90 + 9 * (1 - Math.exp(-(ratio - 0.9) * 4));
        if (fillEl) {
            fillEl.style.width = Math.min(percent, 99).toFixed(1) + "%";
        }
    }

    async function track(tabName, promiseFunction) {
        initUI();
        const tab = tabName || "default";
        const estimatedSec = getEstimate(tab);
        const startTime = performance.now();

        let timerShow = setTimeout(() => {
            if (box) box.hidden = false;
        }, SHOW_AFTER);

        let intervalLoop = setInterval(() => {
            const elapsedSec = (performance.now() - startTime) / 1000;
            updateDisplay(estimatedSec - elapsedSec, elapsedSec, estimatedSec);
        }, 200);

        try {
            const result = await promiseFunction();
            const actualSec = (performance.now() - startTime) / 1000;
            recordTime(tab, actualSec);

            if (fillEl) fillEl.style.width = "100%";
            return result;
        } finally {
            clearTimeout(timerShow);
            clearInterval(intervalLoop);
            setTimeout(() => {
                if (box) box.hidden = true;
                if (fillEl) fillEl.style.width = "0%";
            }, 300);
        }
    }

    return { track };
})();

if (typeof Api !== "undefined" && typeof Api?.image?.process === "function") {
    const originalProcess = Api.image.process;
    Api.image.process = function (args = {}) {
        const tabKey = args.tab || "default";
        return Eta.track(tabKey, () => originalProcess.call(this, args));
    };
}