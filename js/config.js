/* ============================================================
   config.js — Single Source of Truth
   ทีมหลังบ้าน: อ่านไฟล์นี้ไฟล์เดียวพอ
   ============================================================ */

const API_BASE = `http://${location.hostname}:7860`;
const USE_MOCK = true;              // ⚠️ เปลี่ยนเป็น false เมื่อหลังบ้านพร้อม
const REQUEST_TIMEOUT = 120000;     // 2 นาที
const STORE = "imgstudio:";         // prefix ของ localStorage

/* ---------- พจนานุกรม 2 ภาษา ---------- */
const I18N = {
    th: {
        "app.title": "AI Image Studio",
        "nav.settings": "ตั้งค่า", "nav.tabs": "จัดการแท็บ",
        "nav.login": "เข้าสู่ระบบ", "nav.logout": "ออกจากระบบ", "nav.guest": "ผู้เยี่ยมชม",
        "prompt.clear": "ล้าง Prompt",
        "prompt.ph": "Prompt\n(อธิบายภาพที่ต้องการ...)",
        "negative.ph": "Negative Prompt\n(สิ่งที่ไม่ต้องการให้มี...)",
        "upload.cta": "ลากรูปมาวาง หรือ", "upload.click": "คลิกเพื่อเลือก",
        "upload.change": "เปลี่ยนรูป", "upload.remove": "เอาออก",
        "result.empty": "ผลลัพธ์จะแสดงที่นี่",
        "result.loading": "กำลังประมวลผล...",
        "result.download": "ดาวน์โหลด", "result.compare": "เทียบก่อน-หลัง",
        "result.before": "ก่อน", "result.after": "หลัง",
        "hint.needPrompt": "กรุณาใส่ Prompt ก่อนกด Generate",
        "hint.needFile": "กรุณาเลือกรูปก่อนครับ",
        "hint.badType": "ไฟล์ต้องเป็น PNG / JPG / WEBP เท่านั้น",
        "hint.tooLarge": "ไฟล์ใหญ่เกิน {n} MB",
        "hint.mock": "⚠️ โหมดจำลอง — ยังไม่ได้ต่อหลังบ้านจริง",
        "hint.abort": "ยกเลิก / หมดเวลารอ",
        "hint.error": "ผิดพลาด: {msg}",
        "settings.title": "ตั้งค่า", "settings.lang": "ภาษา",
        "settings.notes": "โน้ตส่วนตัว",
        "settings.notesPh": "จดไอเดีย prompt หรืออะไรก็ได้ที่นี่ — บันทึกอัตโนมัติ",
        "settings.saved": "บันทึกแล้ว", "settings.reset": "ล้างข้อมูลทั้งหมด",
        "settings.resetOk": "ล้างข้อมูลเรียบร้อย",
        "tabs.title": "จัดการแท็บ",
        "tabs.desc": "เลือกแท็บที่ต้องการแสดง และเรียงลำดับได้ตามใจ",
        "tabs.min": "ต้องเปิดไว้อย่างน้อย 1 แท็บ",
        "auth.title": "เข้าสู่ระบบ", "auth.titleReg": "สมัครสมาชิก",
        "auth.name": "ชื่อที่แสดง", "auth.email": "อีเมล", "auth.pass": "รหัสผ่าน",
        "auth.login": "เข้าสู่ระบบ", "auth.register": "สมัครสมาชิก",
        "auth.toReg": "ยังไม่มีบัญชี? สมัครเลย", "auth.toLogin": "มีบัญชีแล้ว? เข้าสู่ระบบ",
        "auth.guest": "ใช้งานแบบไม่ล็อกอิน",
        "auth.errFields": "กรอกข้อมูลให้ครบก่อนครับ",
        "auth.errEmail": "รูปแบบอีเมลไม่ถูกต้อง",
        "auth.errShort": "รหัสผ่านต้องยาวอย่างน้อย 6 ตัว",
        "auth.errExists": "อีเมลนี้ถูกใช้แล้ว",
        "auth.errNoUser": "ไม่พบบัญชีนี้",
        "auth.errPass": "รหัสผ่านไม่ถูกต้อง",
        "auth.welcome": "ยินดีต้อนรับ {name}",
        "auth.mockNote": "🧪 บัญชีเก็บในเครื่องนี้เท่านั้น (mock) ยังไม่ได้ต่อหลังบ้าน",
        "badge.mock": "🧪 MOCK MODE — ยังไม่ได้เชื่อมหลังบ้าน",
        "common.close": "ปิด", "common.cancel": "ยกเลิก",
    },
    en: {
        "app.title": "AI Image Studio",
        "nav.settings": "Settings", "nav.tabs": "Manage tabs",
        "nav.login": "Sign in", "nav.logout": "Sign out", "nav.guest": "Guest",
        "prompt.clear": "Clear prompt",
        "prompt.ph": "Prompt\n(Describe the image you want...)",
        "negative.ph": "Negative Prompt\n(Describe what you don't want...)",
        "upload.cta": "Drop an image here or", "upload.click": "click to browse",
        "upload.change": "Change", "upload.remove": "Remove",
        "result.empty": "Your result will appear here",
        "result.loading": "Processing...",
        "result.download": "Download", "result.compare": "Compare",
        "result.before": "Before", "result.after": "After",
        "hint.needPrompt": "Please enter a prompt first",
        "hint.needFile": "Please choose an image first",
        "hint.badType": "Only PNG / JPG / WEBP are allowed",
        "hint.tooLarge": "File exceeds {n} MB",
        "hint.mock": "⚠️ Mock mode — backend not connected yet",
        "hint.abort": "Cancelled / timed out",
        "hint.error": "Error: {msg}",
        "settings.title": "Settings", "settings.lang": "Language",
        "settings.notes": "Personal notes",
        "settings.notesPh": "Jot down prompt ideas — saved automatically",
        "settings.saved": "Saved", "settings.reset": "Clear all data",
        "settings.resetOk": "All data cleared",
        "tabs.title": "Manage tabs",
        "tabs.desc": "Choose which tabs to show and reorder them.",
        "tabs.min": "At least one tab must stay visible",
        "auth.title": "Sign in", "auth.titleReg": "Create account",
        "auth.name": "Display name", "auth.email": "Email", "auth.pass": "Password",
        "auth.login": "Sign in", "auth.register": "Create account",
        "auth.toReg": "No account? Sign up", "auth.toLogin": "Have an account? Sign in",
        "auth.guest": "Continue as guest",
        "auth.errFields": "Please fill in every field",
        "auth.errEmail": "Invalid email format",
        "auth.errShort": "Password must be at least 6 characters",
        "auth.errExists": "That email is already registered",
        "auth.errNoUser": "Account not found",
        "auth.errPass": "Incorrect password",
        "auth.welcome": "Welcome, {name}",
        "auth.mockNote": "🧪 Accounts are stored locally (mock) — no backend yet",
        "badge.mock": "🧪 MOCK MODE — backend not connected",
        "common.close": "Close", "common.cancel": "Cancel",
    },
};

/* ---------- แท็บทั้งหมด ---------- */
const TAB_ORDER = ["genimage", "back", "icon", "tone"];

const TAB_CONFIG = {
    genimage: {
        label: "GenImage", type: "text2img",
        usesPrompt: true, needsFile: false,
        endpoint: "/api/v1/generate", contentType: "application/json",
        cta: { th: "สร้างภาพ", en: "Generate" },
        hint: { th: "อธิบายภาพที่ต้องการให้ละเอียด", en: "Describe your image in detail" },
        returns: "image/png",
        fields: {
            size: {
                kind: "enum", label: { th: "ขนาดภาพ", en: "Size" }, default: "1024x1024",
                values: [
                    { v: "1024x1024", th: "จัตุรัส 1:1", en: "Square 1:1" },
                    { v: "1024x1536", th: "แนวตั้ง 2:3", en: "Portrait 2:3" },
                    { v: "1536x1024", th: "แนวนอน 3:2", en: "Landscape 3:2" },
                ],
            },
            steps: { kind: "range", label: { th: "จำนวนรอบ", en: "Steps" }, min: 10, max: 50, step: 5, default: 30 },
        },
    },
    back: {
        label: "Back", type: "img2img",
        usesPrompt: false, needsFile: true,
        endpoint: "/api/v1/remove-background", contentType: "multipart/form-data",
        cta: { th: "ลบพื้นหลัง", en: "Remove Background" },
        hint: { th: "PNG / JPG / WEBP · ไม่เกิน 12 MB", en: "PNG / JPG / WEBP · max 12 MB" },
        accept: ["image/png", "image/jpeg", "image/webp"], maxMB: 12,
        returns: "image/png",
        fields: {
            output: {
                kind: "enum", label: { th: "รูปแบบผลลัพธ์", en: "Output" }, default: "transparent",
                values: [
                    { v: "transparent", th: "โปร่งใส", en: "Transparent" },
                    { v: "white", th: "พื้นขาว", en: "White" },
                    { v: "black", th: "พื้นดำ", en: "Black" },
                ],
            },
            refine_edge: { kind: "bool", label: { th: "เกลาขอบให้เนียน", en: "Refine edges" }, default: true },
        },
    },
    icon: {
        label: "Icon", type: "img2img",
        usesPrompt: false, needsFile: true,
        endpoint: "/api/v1/clean-image", contentType: "multipart/form-data",
        cta: { th: "ลบลายน้ำ & นอยส์", en: "Clean Image" },
        hint: { th: "ภาพที่มีลายน้ำหรือนอยส์ · ไม่เกิน 12 MB", en: "Watermarked or noisy image · max 12 MB" },
        accept: ["image/png", "image/jpeg", "image/webp"], maxMB: 12,
        returns: "image/png",
        fields: {
            denoise: {
                kind: "enum", label: { th: "ระดับลดนอยส์", en: "Denoise" }, default: "medium",
                values: [
                    { v: "low", th: "เบา", en: "Low" },
                    { v: "medium", th: "กลาง", en: "Medium" },
                    { v: "high", th: "แรง", en: "High" },
                ],
            },
            remove_watermark: { kind: "bool", label: { th: "ลบลายน้ำ", en: "Remove watermark" }, default: true },
        },
    },
    tone: {
        label: "Tone", type: "img2img",
        usesPrompt: false, needsFile: true,
        endpoint: "/api/v1/color-grade", contentType: "multipart/form-data",
        cta: { th: "ปรับโทนสี", en: "Color Grade" },
        hint: { th: "PNG / JPG / WEBP · ไม่เกิน 20 MB", en: "PNG / JPG / WEBP · max 20 MB" },
        accept: ["image/png", "image/jpeg", "image/webp"], maxMB: 20,
        returns: "image/jpeg",
        fields: {
            tone: {
                kind: "enum", label: { th: "โทนสี", en: "Tone" }, default: "warm",
                values: [
                    { v: "warm", th: "อบอุ่น", en: "Warm" },
                    { v: "cool", th: "เย็น", en: "Cool" },
                    { v: "pastel", th: "พาสเทล", en: "Pastel" },
                    { v: "mono", th: "ขาวดำ", en: "Mono" },
                    { v: "vivid", th: "สดจัด", en: "Vivid" },
                    { v: "cinematic", th: "ภาพยนตร์", en: "Cinematic" },
                ],
            },
            strength: { kind: "range", label: { th: "ความเข้ม", en: "Strength" }, min: 0, max: 100, step: 5, default: 70, suffix: "%" },
        },
    },
};