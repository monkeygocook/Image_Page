// ===================== ตั้งค่า =====================
const USE_MOCK = true;   // true = จำลองผล (ยังไม่มีหลังบ้าน) | false = ยิง API จริง
const API_URL = "http://localhost:8000/api/generate";
const MOCK_IMAGE = "image/Beta_T.png";   // รูปตัวอย่างที่คุณมีอยู่แล้ว

// ===================== อ้างอิง Element =====================
const genForm = document.getElementById("genForm");
const promptEl = document.getElementById("prompt");
const negativeEl = document.getElementById("negativePrompt");
const generateBtn = document.getElementById("generateBtn");
const errorMsg = document.getElementById("errorMsg");

const placeholder = document.getElementById("placeholder");
const loading = document.getElementById("loading");
const resultImage = document.getElementById("resultImage");
const downloadBtn = document.getElementById("downloadBtn");

const modal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const modalClose = document.getElementById("modalClose");

let currentImageUrl = null;   // เก็บ URL รูปล่าสุดไว้ให้ปุ่มดาวน์โหลด


// ===================== 1) สลับแท็บเมนู =====================
document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active"));
        tab.classList.add("is-active");

        // ตอนนี้ทำแค่ฟังก์ชัน GenImage ฟังก์ชันอื่นค่อยเพิ่มทีหลัง
        if (tab.dataset.tab !== "genimage") {
            alert("ฟังก์ชัน " + tab.textContent + " ยังไม่เปิดใช้งานครับ");
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active"));
            document.querySelector('[data-tab="genimage"]').classList.add("is-active");
        }
    });
});


// ===================== 2) สลับสถานะกล่องภาพ =====================
// state = "empty" | "loading" | "done"
function setImageState(state, url) {
    placeholder.hidden = (state !== "empty");
    loading.hidden = (state !== "loading");
    resultImage.hidden = (state !== "done");

    generateBtn.disabled = (state === "loading");
    generateBtn.textContent = (state === "loading") ? "Generating..." : "Generate";

    if (state === "done") {
        resultImage.src = url;
        currentImageUrl = url;
        downloadBtn.disabled = false;
        downloadBtn.classList.remove("is-disabled");
    } else {
        currentImageUrl = null;
        downloadBtn.disabled = true;
        downloadBtn.classList.add("is-disabled");
    }
}

function showError(text) {
    errorMsg.textContent = text;
    errorMsg.hidden = !text;
}


// ===================== 3) เรียกหลังบ้าน =====================
async function generateImage(prompt, negativePrompt) {

    // --- โหมดจำลอง: หน่วง 1.5 วิ แล้วคืนรูปตัวอย่าง ---
    if (USE_MOCK) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return MOCK_IMAGE;
    }

    // --- โหมดจริง ---
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt: prompt,
            negative_prompt: negativePrompt,
            width: 512,
            height: 768
        })
    });

    if (!response.ok) {
        throw new Error("เซิร์ฟเวอร์ตอบกลับผิดพลาด (" + response.status + ")");
    }

    const data = await response.json();

    // ปรับตรงนี้ให้ตรงกับที่หลังบ้านส่งกลับมา:
    // แบบ URL       -> return data.image_url;
    // แบบ base64    -> return "data:image/png;base64," + data.image_base64;
    return data.image_url;
}


// ===================== 4) กดปุ่ม Generate =====================
genForm.addEventListener("submit", async function (event) {
    event.preventDefault();          // กัน browser refresh หน้า
    showError("");

    const prompt = promptEl.value.trim();
    const negativePrompt = negativeEl.value.trim();

    if (prompt === "") {
        showError("กรุณากรอก Prompt ก่อนครับ");
        promptEl.focus();
        return;
    }

    setImageState("loading");

    try {
        const url = await generateImage(prompt, negativePrompt);
        setImageState("done", url);
    } catch (err) {
        console.error(err);
        showError("สร้างภาพไม่สำเร็จ: " + err.message);
        setImageState("empty");
    }
});


// ===================== 5) ดาวน์โหลดภาพ =====================
downloadBtn.addEventListener("click", async function () {
    if (!currentImageUrl) return;

    try {
        // ดึงไฟล์มาเป็น blob ก่อน เพื่อให้ดาวน์โหลดได้แม้รูปมาจากคนละโดเมน
        const response = await fetch(currentImageUrl);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = "genimage-" + Date.now() + ".png";
        link.click();

        URL.revokeObjectURL(blobUrl);   // คืนหน่วยความจำ
    } catch (err) {
        console.error(err);
        showError("ดาวน์โหลดไม่สำเร็จครับ");
    }
});


// ===================== 6) Modal ดูรูปใหญ่ =====================
resultImage.addEventListener("click", function () {
    modalImage.src = resultImage.src;
    modal.classList.add("is-open");
});

modal.addEventListener("click", function () {
    modal.classList.remove("is-open");
});

modalClose.addEventListener("click", function () {
    modal.classList.remove("is-open");
});

document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") modal.classList.remove("is-open");
});


// ===================== เริ่มต้น =====================
setImageState("empty");