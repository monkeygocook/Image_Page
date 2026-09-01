"use strict";

/* ============================================================
   0) อ้างอิง Element ทั้งหมด
   ============================================================ */
const genForm = document.getElementById("genForm");
const promptInput = document.getElementById("promptInput");
const negativeInput = document.getElementById("negativeInput");
const generateBtn = document.getElementById("generateBtn");
const cancelBtn = document.getElementById("cancelBtn");
const clearBtn = document.getElementById("clearBtn");
const saveHint = document.getElementById("saveHint");
const errorMsg = document.getElementById("errorMsg");

const placeholder = document.getElementById("placeholder");
const loading = document.getElementById("loading");
const resultImage = document.getElementById("resultImage");
const downloadBtn = document.getElementById("downloadBtn");

const modal = document.getElementById("modal");
const modalImage = document.getElementById("modalImage");
const modalClose = document.getElementById("modalClose");

/* ตัวแปรสถานะ */
let currentImageUrl = null;   // URL ของภาพที่แสดงอยู่
let controller = null;   // AbortController ของรอบที่กำลังทำงาน


/* ============================================================
   1) จำ Prompt ด้วย localStorage
   ============================================================ */
const STORAGE_KEY = "genimage:prompts";
const SAVE_DELAY = 500;      // หน่วง 0.5 วิ ค่อยบันทึก (debounce)
let saveTimer = null;

/* --- โหลด Prompt ที่บันทึกไว้ตอนเปิดหน้า --- */
function loadPrompts() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const data = JSON.parse(raw);
        promptInput.value = data.prompt || "";
        negativeInput.value = data.negative || "";

        if (data.prompt || data.negative) {
            showHint("กู้คืน Prompt ล่าสุดแล้ว");
        }
    } catch (err) {
        console.warn("อ่าน localStorage ไม่ได้:", err);
    }
}

/* --- บันทึก (แบบ debounce) --- */
function savePrompts() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                prompt: promptInput.value,
                negative: negativeInput.value,
                savedAt: Date.now()
            }));
            showHint("บันทึกแล้ว");
        } catch (err) {
            console.warn("เขียน localStorage ไม่ได้:", err);
        }
    }, SAVE_DELAY);
}

/* --- ข้อความแจ้งเตือนเล็ก ๆ --- */
let hintTimer = null;
function showHint(text) {
    saveHint.textContent = text;
    saveHint.classList.add("is-visible");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
        saveHint.classList.remove("is-visible");
    }, 1800);
}

promptInput.addEventListener("input", savePrompts);
negativeInput.addEventListener("input", savePrompts);

clearBtn.addEventListener("click", function () {
    if (!promptInput.value && !negativeInput.value) return;
    if (!confirm("ล้าง Prompt ทั้งหมดใช่ไหม?")) return;

    promptInput.value = "";
    negativeInput.value = "";
    localStorage.removeItem(STORAGE_KEY);
    showHint("ล้างแล้ว");
    promptInput.focus();
});

loadPrompts();


/* ============================================================
   2) สร้างภาพ + ยกเลิก
   ============================================================ */
genForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt) {
        showError("กรุณาใส่ Prompt ก่อนกด Generate");
        promptInput.focus();
        return;
    }

    hideError();
    setBusy(true);
    controller = new AbortController();

    try {
        const url = await generateImage(prompt, negativeInput.value.trim(), controller.signal);
        showImage(url);

    } catch (err) {
        resetOutput();
        if (err.name === "AbortError") {
            showError("ยกเลิกการสร้างภาพแล้ว");
        } else {
            showError("สร้างภาพไม่สำเร็จ: " + err.message);
        }

    } finally {
        setBusy(false);
        controller = null;
    }
});

/* --- ปุ่มยกเลิก --- */
cancelBtn.addEventListener("click", function () {
    if (controller) controller.abort();
});

/* --- กด Esc = ยกเลิก / Ctrl+Enter = สร้าง --- */
document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && controller) {
        controller.abort();
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !controller) {
        genForm.requestSubmit();
    }
});

/* --- เตือนก่อนปิดหน้าขณะกำลังสร้าง --- */
window.addEventListener("beforeunload", function (event) {
    if (controller) {
        event.preventDefault();
        event.returnValue = "";
    }
});


/* ============================================================
   3) ฟังก์ชันสร้างภาพ (โหมดจำลอง — รองรับการยกเลิก)
   ============================================================ */
function generateImage(prompt, negative, signal) {
    return new Promise(function (resolve, reject) {
        if (signal.aborted) return reject(makeAbortError());

        const timer = setTimeout(function () {
            cleanup();
            const seed = encodeURIComponent(prompt).slice(0, 20);
            resolve("https://picsum.photos/seed/" + seed + "/800/1200");
        }, 5000);

        function onAbort() {
            clearTimeout(timer);
            cleanup();
            reject(makeAbortError());
        }
        function cleanup() {
            signal.removeEventListener("abort", onAbort);
        }
        signal.addEventListener("abort", onAbort);
    });
}

function makeAbortError() {
    const err = new Error("ผู้ใช้ยกเลิก");
    err.name = "AbortError";
    return err;
}

/* ------------------------------------------------------------
    เมื่อได้ API จริงแล้ว ให้ลบฟังก์ชันด้านบน แล้วใช้อันนี้แทน
   (โค้ดส่วนอื่นไม่ต้องแก้เลย — ปุ่มยกเลิกทำงานได้ทันที)

const API_URL = "http://127.0.0.1:7860/generate";

async function generateImage(prompt, negative, signal) {
    const res = await fetch(API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ prompt: prompt, negative_prompt: negative }),
        signal:  signal
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data.image_url;
}
------------------------------------------------------------ */


/* ============================================================
   4) จัดการสถานะหน้าจอ
   ============================================================ */
function setBusy(isBusy) {
    loading.hidden = !isBusy;
    generateBtn.hidden = isBusy;
    cancelBtn.hidden = !isBusy;

    if (isBusy) {
        placeholder.hidden = true;
        resultImage.hidden = true;
        setDownloadEnabled(false);
    }
}

function showImage(url) {
    currentImageUrl = url;
    resultImage.src = url;
    resultImage.hidden = false;
    placeholder.hidden = true;
    setDownloadEnabled(true);
}

function resetOutput() {
    currentImageUrl = null;
    resultImage.src = "";
    resultImage.hidden = true;
    placeholder.hidden = false;
    setDownloadEnabled(false);
}

function setDownloadEnabled(enabled) {
    downloadBtn.disabled = !enabled;
    downloadBtn.classList.toggle("is-disabled", !enabled);
}

function showError(text) {
    errorMsg.textContent = text;
    errorMsg.hidden = false;
}

function hideError() {
    errorMsg.textContent = "";
    errorMsg.hidden = true;
}


/* ============================================================
   5) ดาวน์โหลดภาพ
   ============================================================ */
downloadBtn.addEventListener("click", async function () {
    if (!currentImageUrl) return;

    const fileName = "genimage-" + Date.now() + ".png";

    try {
        const response = await fetch(currentImageUrl);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        triggerDownload(blobUrl, fileName);
        URL.revokeObjectURL(blobUrl);
    } catch (err) {
        console.warn("fetch ไม่ผ่าน ใช้วิธีสำรองแทน:", err);
        triggerDownload(currentImageUrl, fileName);
    }
});

function triggerDownload(url, fileName) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}


/* ============================================================
   6) แท็บ + Modal ดูภาพขยาย
   ============================================================ */
document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) {
            t.classList.remove("is-active");
        });
        tab.classList.add("is-active");
    });
});

resultImage.addEventListener("click", function () {
    if (!currentImageUrl) return;
    modalImage.src = currentImageUrl;
    modal.classList.add("is-open");
});

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", function (event) {
    if (event.target === modal) closeModal();
});

function closeModal() {
    modal.classList.remove("is-open");
    modalImage.src = "";
}