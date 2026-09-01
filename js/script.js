// ===================== ตั้งค่า =============================
const USE_MOCK = true;   // true = จำลองผล (ยังไม่มีหลังบ้าน) | false = ยิง API จริง
const API_URL = "http://localhost:8000/api/generate";
const MOCK_IMAGE = "image/Beta_T.png";   // รูปตัวอย่างที่คุณมีอยู่แล้ว

// ===================== อ้างอิง Element =====================
const genForm = document.getElementById("genForm"); // ฟอร์ม GenImage
const promptEl = document.getElementById("prompt"); // กล่อง Prompt
const negativeEl = document.getElementById("negativePrompt"); // กล่อง Negative Prompt
const generateBtn = document.getElementById("generateBtn"); // ปุ่ม Generate
const errorMsg = document.getElementById("errorMsg");  // กล่องข้อความแจ้งข้อผิดพลาด

const placeholder = document.getElementById("placeholder"); // กล่อง placeholder
const loading = document.getElementById("loading"); // กล่อง loading
const resultImage = document.getElementById("resultImage"); // รูปที่สร้างเสร็จแล้ว
const downloadBtn = document.getElementById("downloadBtn"); // ปุ่มดาวน์โหลด

const modal = document.getElementById("imageModal"); // กล่อง modal
const modalImage = document.getElementById("modalImage"); // รูปใน modal
const modalClose = document.getElementById("modalClose"); // ปุ่มปิด modal

let currentImageUrl = null;   // เก็บ URL รูปล่าสุดไว้ให้ปุ่มดาวน์โหลด


// ===================== 1) สลับแท็บเมนู =====================
document.querySelectorAll(".tab").forEach(function (tab) { // วนลูปทุกแท็บ
    tab.addEventListener("click", function () { // เมื่อคลิกแท็บ
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active")); // เอา class is-active ออกจากทุกแท็บ
        tab.classList.add("is-active"); // เพิ่ม class is-active ให้แท็บที่คลิก

        // ตอนนี้ทำแค่ฟังก์ชัน GenImage ฟังก์ชันอื่นค่อยเพิ่มทีหลัง
        if (tab.dataset.tab !== "genimage") { // ถ้าไม่ใช่แท็บ GenImage
            alert("ฟังก์ชัน " + tab.textContent + " ยังไม่เปิดใช้งานครับ"); // แจ้งเตือน
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active")); // เอา class is-active ออกจากทุกแท็บ
            document.querySelector('[data-tab="genimage"]').classList.add("is-active"); // เพิ่ม class is-active ให้แท็บ GenImage
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

    const prompt = promptEl.value.trim(); // เอา space หน้า-หลังออก
    const negativePrompt = negativeEl.value.trim(); // เอา space หน้า-หลังออก

    if (prompt === "") {
        showError("กรุณากรอก Prompt ก่อนครับ");
        promptEl.focus();
        return;
    }

    setImageState("loading");

    try {
        const url = await generateImage(prompt, negativePrompt); // เรียกหลังบ้าน
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

    const fileName = "genimage-" + Date.now() + ".png";

    try {
        // วิธีหลัก: ดึงเป็น blob (ใช้ได้กับรูปจากเซิร์ฟเวอร์คนละโดเมน)
        const response = await fetch(currentImageUrl); // อาจเกิด CORS ถ้าเซิร์ฟเวอร์ไม่อนุญาต
        const blob = await response.blob(); // แปลงเป็น blob
        const blobUrl = URL.createObjectURL(blob); // สร้าง URL ชั่วคราวจาก blob

        triggerDownload(blobUrl, fileName); // สั่งดาวน์โหลด
        URL.revokeObjectURL(blobUrl); // ลบ URL ชั่วคราวทิ้งหลังดาวน์โหลดเสร็จ

    } catch (err) {
        // วิธีสำรอง: ลิงก์ตรง (ใช้ได้ตอนเปิดไฟล์แบบ file:///)
        console.warn("fetch ไม่ผ่าน ใช้วิธีสำรองแทน:", err); // อาจเกิด CORS หรือไฟล์ไม่อยู่แล้ว
        triggerDownload(currentImageUrl, fileName);
    }
});

// สร้างลิงก์ชั่วคราวแล้วสั่งคลิกอัตโนมัติ
function triggerDownload(url, fileName) { // url = blob หรือ url ปกติ
    const link = document.createElement("a"); // สร้าง <a> ชั่วคราว
    link.href = url; // กำหนด URL ของไฟล์
    link.download = fileName;
    document.body.appendChild(link); // ต้องแปะก่อนถึงจะสั่งคลิกได้
    link.click();
    document.body.removeChild(link); // ลบ <a> ชั่วคราวออก
}


// ===================== 6) Modal ดูรูปใหญ่ =====================
resultImage.addEventListener("click", function () { // คลิกที่รูปเล็ก
    modalImage.src = resultImage.src;
    modal.classList.add("is-open");
});

modal.addEventListener("click", function () { // คลิกที่พื้นหลัง
    modal.classList.remove("is-open");
});

modalClose.addEventListener("click", function () { // คลิกที่ปุ่มปิด
    modal.classList.remove("is-open");
});

document.addEventListener("keydown", function (e) { // กดปุ่ม Escape ปิด modal
    if (e.key === "Escape") modal.classList.remove("is-open");
});


// ===================== เริ่มต้น =====================
setImageState("empty");