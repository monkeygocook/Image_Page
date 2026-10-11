/* =============================================================
   eta.js — แสดงเวลาคาดการณ์บนปุ่มสีส้มหลัก (submitBtn) โดยตรง
   ============================================================= */

const Eta = (() => {
    const KEY = "eta:actual_durations";
    const KEEP = 5;
    const SHOW_AFTER = 400;
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

    let btn, originalHtml = "";

    function initUI() {
        if (!btn) {
            btn = document.getElementById("submitBtn");
        }
        if (btn && !originalHtml) {
            originalHtml = btn.innerHTML;
        }
    }

    const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    function updateDisplay(remaining, elapsed, est) {
        initUI();
        if (!btn) return;

        let msg = "";
        if (remaining > 60) {
            msg = `เหลือ ~${Math.ceil(remaining / 60)} นาที`;
        } else if (remaining > 5) {
            msg = `เหลือ ~${Math.round(remaining)} วิ`;
        } else {
            msg = "ใกล้เสร็จแล้ว...";
        }

        const ratio = elapsed / est;
        const percent = ratio < 0.9 ? ratio * 90 : 90 + 9 * (1 - Math.exp(-(ratio - 0.9) * 4));
        const pctStr = Math.min(percent, 99).toFixed(0) + "%";

        // จัดรูปแบบการแสดงผลให้อยู่บนปุ่มสีส้ม พร้อมแถบวิ่งจำลองด้านล่างสุดของปุ่ม
        btn.style.position = "relative";
        btn.style.overflow = "hidden";
        btn.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 0 4px;">
                <span style="font-weight: 500;">⏳ ${msg} (${formatTime(elapsed)})</span>
                <span style="font-size: 12px; opacity: 0.9;">${pctStr}</span>
            </div>
            <div style="position: absolute; bottom: 0; left: 0; height: 4px; width: ${pctStr}; background: rgba(255, 255, 255, 0.85); transition: width 0.2s linear; border-radius: 0 0 6px 6px;"></div>
        `;
    }

    function restoreButton() {
        if (btn && originalHtml) {
            btn.innerHTML = originalHtml;
            btn.style.position = "";
            btn.style.overflow = "";
            originalHtml = ""; // รีเซ็ตเพื่อดึงข้อความใหม่ในรอบถัดไปหากเปลี่ยนแท็บ
        }
    }

    async function track(tabName, promiseFunction) {
        initUI();
        const tab = tabName || "default";
        const estimatedSec = getEstimate(tab);
        const startTime = performance.now();

        let timerShow = setTimeout(() => {
            // เริ่มแสดงผลบนปุ่มหลังจากผ่านไปชั่วครู่
        }, SHOW_AFTER);

        let intervalLoop = setInterval(() => {
            const elapsedSec = (performance.now() - startTime) / 1000;
            updateDisplay(estimatedSec - elapsedSec, elapsedSec, estimatedSec);
        }, 200);

        try {
            const result = await promiseFunction();
            const actualSec = (performance.now() - startTime) / 1000;
            recordTime(tab, actualSec);
            return result;
        } finally {
            clearTimeout(timerShow);
            clearInterval(intervalLoop);
            restoreButton();
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