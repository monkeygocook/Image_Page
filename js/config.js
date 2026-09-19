/* ============================================================
   config.js — Single Source of Truth
   ทีมหลังบ้าน: อ่านไฟล์นี้ไฟล์เดียวพอ ทุก endpoint และ field อยู่ที่นี่
   ============================================================ */
/* ============================================================
   จุดเชื่อมต่อ Backend
   ผู้ใช้เปิดหน้าเว็บที่พอร์ต 8000 — ส่วนนี้ชี้ไปพอร์ต 5000 ของ backend
   ============================================================ */
const BACKEND_PORT = 5000;

const API_BASE = `${location.protocol}//${location.hostname}:${BACKEND_PORT}`;


/* โหมดการทำงาน:
   "mock" = ใช้ข้อมูลจำลองเสมอ (พัฒนา UI)
   "live" = ยิง Backend จริงเสมอ (production)
   "auto" = ตรวจ /health ตอนเปิดหน้า เจอก็ใช้จริง ไม่เจอก็ถอยไป mock  ← แนะนำตอนนี้ */
const API_MODE = "auto";   // auto = ping 5000 ก่อน ถ้าไม่ตอบค่อยถอยไป mock

const REQUEST_TIMEOUT = 120000;     // เวลารอสูงสุดต่อ 1 request (2 นาที)
/* งานประมวลผลภาพใช้เวลานานกว่า request ทั่วไปมาก ต้องแยก timeout */
const PROCESS_TIMEOUT = 120000;   // 2 นาที
/* ============================================================
   การแสดงผลป้ายแจ้งเตือนโหมดจำลอง
   แก้ที่นี่ = ค่าตั้งต้น · แก้สดตอนรัน = ใช้ Console (ดูท้ายบล็อก)
   ============================================================ */
const MOCK_UI_DEFAULT = {
    enabled: true,    // สวิตช์ใหญ่ — false = ปิดทั้ง 4 ตัวทันที
    banner: true,     // 1. แถบส้มบนสุด
    pill: true,       // 2. ป้ายสถานะมุมขวาบน
    seedHint: true,   // 3. กล่องบัญชีทดสอบในหน้า login
    mockNote: true,   // 4. บรรทัดหมายเหตุใต้ฟอร์ม login
};
/* โหมดเผยแพร่ต่อผู้ใช้ทั่วไป
   true  = ทุกบัญชีเป็น user, ไม่มีหน้า admin, ไม่มีป้ายโหมดจำลอง
   false = โหมดพัฒนา เห็นทุกอย่าง */
const PUBLIC_MODE = true;


/** อ่านค่าจริง = ค่าตั้งต้น ทับด้วยค่าที่ผู้ใช้ตั้งไว้ใน localStorage */
function mockUI() {
    if (PUBLIC_MODE) {
        return { enabled: false, banner: false, pill: false, seedHint: false, mockNote: false };
    }
    let saved = {};
    // ...(ส่วนที่เหลือคงเดิม)
}

/* วิธีปรับสดใน Console (ไม่ต้องแก้ไฟล์ ไม่ต้องรีสตาร์ต):
   setMockUI({ banner: false })        ปิดเฉพาะแถบส้ม
   setMockUI({ enabled: false })       ปิดทั้งหมด
   setMockUI(null)                     คืนค่าตั้งต้น
*/
function setMockUI(patch) {
    if (patch === null) localStorage.removeItem(STORE + "mockui");
    else {
        let cur = {};
        try { cur = JSON.parse(localStorage.getItem(STORE + "mockui") || "{}"); } catch { }
        localStorage.setItem(STORE + "mockui", JSON.stringify({ ...cur, ...patch }));
    }
    if (typeof applyMockUI === "function") applyMockUI();
    return mockUI();
}
const HEALTH_TIMEOUT = 4000;        // ตรวจสุขภาพเซิร์ฟเวอร์ ต้องตอบเร็ว
const HEALTH_INTERVAL = 30000;      // ตรวจซ้ำทุก 30 วินาที (เฉพาะโหมด live)
const NET_RETRY = 1;                // ลองซ้ำกี่ครั้งเมื่อเน็ตสะดุด (เฉพาะ GET)
const MOCK_DELAY_MS = 1200;         // หน่วงจำลองเวลาประมวลผล
const MOCK_MAX_SIDE = 1600;         // ย่อภาพก่อนประมวลผลใน mock กันเบราว์เซอร์ค้าง

const STORE = "imgstudio:";         // prefix ของ localStorage

/* ---------- รายการ endpoint ทั้งหมด ---------- */
const ENDPOINTS = {
    health: "/api/v1/health",

    register: "/api/v1/auth/register",
    login: "/api/v1/auth/login",
    me: "/api/v1/auth/me",
    logout: "/api/v1/auth/logout",

    notes: "/api/v1/notes",
    preferences: "/api/v1/preferences",

    adminUsers: "/api/v1/admin/users",
    adminUserRole: (id) => `/api/v1/admin/users/${encodeURIComponent(id)}/role`,
    adminUser: (id) => `/api/v1/admin/users/${encodeURIComponent(id)}`,
};

/* ---------- การควบคุมการเข้าถึง ---------- */
const REQUIRE_AUTH = true;          // true = ต้องล็อกอินก่อนใช้งานทุกฟังก์ชัน
const SESSION_TTL_HOURS = 24;       // อายุ session (ชั่วโมง) หมดแล้วเด้งออกอัตโนมัติ
const ROLES = ["user", "staff"];    // สิทธิ์ทั้งหมดในระบบ
const ADMIN_PAGE = "admin.html";    // หน้าเจ้าหน้าที่
const APP_PAGE = "index.html";      // หน้าผู้ใช้ทั่วไป

/* บัญชีเจ้าหน้าที่ตั้งต้น — สร้างอัตโนมัติเมื่อยังไม่มี staff ในระบบ
   ⚠️ โหมด mock เท่านั้น ระบบจริงต้องสร้างจากฝั่งหลังบ้าน (seed script / CLI) */
const SEED_STAFF = {
    name: "Staff Admin",
    email: "staff@local.dev",
    password: "Staff1234",
    role: "staff",
};

/* ---------- พจนานุกรม 2 ภาษา ---------- */
const I18N = {
    th: {
        "app.title": "AI Image Studio",
        "nav.settings": "ตั้งค่า", "nav.tabs": "จัดการแท็บ",
        "nav.login": "เข้าสู่ระบบ", "nav.logout": "ออกจากระบบ", "nav.guest": "ยังไม่ได้เข้าสู่ระบบ",
        "nav.admin": "หน้าเจ้าหน้าที่",
        "role.user": "ผู้ใช้ทั่วไป", "role.staff": "เจ้าหน้าที่",

        "conn.mock": "จำลอง", "conn.online": "เชื่อมต่อแล้ว",
        "conn.offline": "ออฟไลน์", "conn.checking": "กำลังตรวจ...",
        "conn.tip": "คลิกเพื่อตรวจสอบการเชื่อมต่อใหม่",

        "prompt.clear": "ล้าง Prompt",
        "prompt.ph": "Prompt\n(อธิบายภาพที่ต้องการ...)",
        "negative.ph": "Negative Prompt\n(สิ่งที่ไม่ต้องการให้มี...)",
        "upload.cta": "ลากรูปมาวาง หรือ", "upload.click": "คลิกเพื่อเลือก",
        "upload.change": "เปลี่ยนรูป", "upload.remove": "เอาออก",
        "result.empty": "ผลลัพธ์จะแสดงที่นี่",
        "result.loading": "กำลังประมวลผล...",
        "result.download": "ดาวน์โหลด", "result.compare": "เทียบก่อน-หลัง",
        "result.before": "ก่อน", "result.after": "หลัง",
        "result.cancel": "ยกเลิก",

        "hint.needPrompt": "กรุณาใส่ Prompt ก่อนกด Generate",
        "hint.needFile": "กรุณาเลือกรูปก่อนครับ",
        "hint.badType": "ไฟล์ต้องเป็น PNG / JPG / WEBP เท่านั้น",
        "hint.tooLarge": "ไฟล์ใหญ่เกิน {n} MB",
        "hint.mock": "⚠️ โหมดจำลอง — ยังไม่ได้ต่อหลังบ้านจริง",
        "hint.abort": "ยกเลิกแล้ว",
        "hint.error": "ผิดพลาด: {msg}",
        "hint.reqId": " (รหัสอ้างอิง: {id})",

        /* ---------- ข้อความผิดพลาดจาก API ---------- */
        "err.NETWORK": "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบว่าหลังบ้านเปิดอยู่หรือไม่",
        "err.TIMEOUT": "เซิร์ฟเวอร์ใช้เวลานานเกินไป ลองใหม่อีกครั้ง",
        "err.UNAUTHORIZED": "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่",
        "err.FORBIDDEN": "บัญชีของคุณไม่มีสิทธิ์ทำรายการนี้",
        "err.NOT_FOUND": "ไม่พบข้อมูลที่ต้องการ",
        "err.VALIDATION_ERROR": "ข้อมูลที่ส่งไปไม่ถูกต้อง",
        "err.INVALID_FILE_TYPE": "ไฟล์ต้องเป็น PNG / JPG / WEBP เท่านั้น",
        "err.FILE_TOO_LARGE": "ไฟล์ใหญ่เกินกำหนด",
        "err.UNPROCESSABLE_IMAGE": "อ่านไฟล์รูปไม่สำเร็จ ลองไฟล์อื่นดูครับ",
        "err.EXPORT_FAILED": "สร้างไฟล์ผลลัพธ์ไม่สำเร็จ",
        "err.RATE_LIMITED": "ใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
        "err.INTERNAL_ERROR": "เซิร์ฟเวอร์เกิดข้อผิดพลาด กรุณาลองใหม่",
        "err.MODEL_UNAVAILABLE": "โมเดลยังโหลดไม่เสร็จ กรุณารอสักครู่",
        "err.EMAIL_TAKEN": "อีเมลนี้ถูกใช้แล้ว",
        "err.INVALID_CREDENTIALS": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
        "err.SELF_FORBIDDEN": "ไม่สามารถแก้สิทธิ์หรือลบบัญชีของตัวเองได้",
        "err.LAST_STAFF": "ต้องเหลือเจ้าหน้าที่อย่างน้อย 1 คนในระบบ",
        "err.UNKNOWN": "เกิดข้อผิดพลาดที่ไม่รู้จัก",

        "settings.title": "ตั้งค่า", "settings.lang": "ภาษา",
        "settings.notes": "โน้ตส่วนตัว",
        "settings.notesPh": "จดไอเดีย prompt หรืออะไรก็ได้ที่นี่ — บันทึกอัตโนมัติ",
        "settings.saved": "บันทึกแล้ว", "settings.reset": "ล้างข้อมูลทั้งหมด",
        "settings.resetOk": "ล้างข้อมูลเรียบร้อย",
        "settings.syncFail": "บันทึกขึ้นเซิร์ฟเวอร์ไม่สำเร็จ (เก็บไว้ในเครื่องแล้ว)",

        "tabs.title": "จัดการแท็บ",
        "tabs.desc": "เลือกแท็บที่ต้องการแสดง และเรียงลำดับได้ตามใจ",
        "tabs.min": "ต้องเปิดไว้อย่างน้อย 1 แท็บ",

        "gate.desc": "ต้องเข้าสู่ระบบก่อน จึงจะใช้งานฟังก์ชันต่าง ๆ ได้",
        "auth.title": "เข้าสู่ระบบ", "auth.titleReg": "สมัครสมาชิก",
        "auth.name": "ชื่อที่แสดง", "auth.email": "อีเมล", "auth.pass": "รหัสผ่าน",
        "auth.login": "เข้าสู่ระบบ", "auth.register": "สมัครสมาชิก",
        "auth.working": "กำลังดำเนินการ...",
        "auth.toReg": "ยังไม่มีบัญชี? สมัครเลย", "auth.toLogin": "มีบัญชีแล้ว? เข้าสู่ระบบ",
        "auth.required": "🔒 กรุณาเข้าสู่ระบบก่อนใช้งาน",
        "auth.expired": "เซสชันหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่",
        "auth.errFields": "กรอกข้อมูลให้ครบก่อนครับ",
        "auth.errEmail": "รูปแบบอีเมลไม่ถูกต้อง",
        "auth.errShort": "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร",
        "auth.errWeak": "รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข",
        "auth.welcome": "ยินดีต้อนรับ {name}",
        "auth.mockNote": "🧪 บัญชีเก็บในเครื่องนี้เท่านั้น (mock) ยังไม่ได้ต่อหลังบ้าน",
        "auth.seedNote": "🔑 บัญชีเจ้าหน้าที่ทดสอบ — {email} / {pass}",
        "badge.mock": "🧪 MOCK MODE — ยังไม่ได้เชื่อมหลังบ้าน",
        "common.close": "ปิด", "common.cancel": "ยกเลิก",

        /* ---------- หน้าเจ้าหน้าที่ ---------- */
        "admin.title": "ระบบจัดการเจ้าหน้าที่",
        "admin.subtitle": "จัดการบัญชีผู้ใช้และสิทธิ์การเข้าถึง",
        "admin.back": "กลับหน้าหลัก",
        "admin.signedAs": "เข้าใช้งานในนาม",
        "admin.denied": "ไม่มีสิทธิ์เข้าถึง",
        "admin.deniedDesc": "หน้านี้สำหรับเจ้าหน้าที่เท่านั้น บัญชีของคุณมีสิทธิ์ระดับ “{role}”",
        "admin.warn": "⚠️ การตรวจสอบสิทธิ์นี้ทำงานฝั่งผู้ใช้เท่านั้น — ระบบจริงต้องตรวจซ้ำที่หลังบ้านทุกครั้ง",
        "admin.statTotal": "ผู้ใช้ทั้งหมด",
        "admin.statStaff": "เจ้าหน้าที่",
        "admin.statUser": "ผู้ใช้ทั่วไป",
        "admin.statSize": "พื้นที่ที่ใช้",
        "admin.search": "ค้นหาชื่อหรืออีเมล...",
        "admin.export": "ส่งออก JSON",
        "admin.refresh": "โหลดใหม่",
        "admin.loading": "กำลังโหลดข้อมูล...",
        "admin.colName": "ชื่อ",
        "admin.colEmail": "อีเมล",
        "admin.colRole": "สิทธิ์",
        "admin.colCreated": "สมัครเมื่อ",
        "admin.colActions": "จัดการ",
        "admin.promote": "เลื่อนเป็นเจ้าหน้าที่",
        "admin.demote": "ลดเป็นผู้ใช้ทั่วไป",
        "admin.delete": "ลบบัญชี",
        "admin.you": "คุณ",
        "admin.empty": "ไม่พบผู้ใช้ที่ตรงกับคำค้นหา",
        "admin.confirmDelete": "ยืนยันลบบัญชี {email} ?\n\nโน้ตส่วนตัวและการตั้งค่าแท็บของผู้ใช้รายนี้จะถูกลบไปด้วย",
        "admin.msgRole": "เปลี่ยนสิทธิ์ {email} เป็น “{role}” เรียบร้อย",
        "admin.msgDeleted": "ลบบัญชี {email} เรียบร้อย",
        "admin.msgExport": "ส่งออกข้อมูลแล้ว (ไม่รวมรหัสผ่าน)",
    },
    en: {
        "app.title": "AI Image Studio",
        "nav.settings": "Settings", "nav.tabs": "Manage tabs",
        "nav.login": "Sign in", "nav.logout": "Sign out", "nav.guest": "Not signed in",
        "nav.admin": "Staff console",
        "role.user": "User", "role.staff": "Staff",

        "conn.mock": "Mock", "conn.online": "Connected",
        "conn.offline": "Offline", "conn.checking": "Checking...",
        "conn.tip": "Click to re-check the connection",

        "prompt.clear": "Clear prompt",
        "prompt.ph": "Prompt\n(Describe the image you want...)",
        "negative.ph": "Negative Prompt\n(Describe what you don't want...)",
        "upload.cta": "Drop an image here or", "upload.click": "click to browse",
        "upload.change": "Change", "upload.remove": "Remove",
        "result.empty": "Your result will appear here",
        "result.loading": "Processing...",
        "result.download": "Download", "result.compare": "Compare",
        "result.before": "Before", "result.after": "After",
        "result.cancel": "Cancel",

        "hint.needPrompt": "Please enter a prompt first",
        "hint.needFile": "Please choose an image first",
        "hint.badType": "Only PNG / JPG / WEBP are allowed",
        "hint.tooLarge": "File exceeds {n} MB",
        "hint.mock": "⚠️ Mock mode — backend not connected yet",
        "hint.abort": "Cancelled",
        "hint.error": "Error: {msg}",
        "hint.reqId": " (request id: {id})",

        "err.NETWORK": "Cannot reach the server. Is the backend running?",
        "err.TIMEOUT": "The server took too long. Please try again.",
        "err.UNAUTHORIZED": "Your session expired. Please sign in again.",
        "err.FORBIDDEN": "Your account is not allowed to do that.",
        "err.NOT_FOUND": "The requested resource was not found.",
        "err.VALIDATION_ERROR": "The data sent was invalid.",
        "err.INVALID_FILE_TYPE": "Only PNG / JPG / WEBP are allowed",
        "err.FILE_TOO_LARGE": "File exceeds the size limit",
        "err.UNPROCESSABLE_IMAGE": "Could not read that image. Try another file.",
        "err.EXPORT_FAILED": "Could not build the result file",
        "err.RATE_LIMITED": "Too many requests. Please wait a moment.",
        "err.INTERNAL_ERROR": "Server error. Please try again.",
        "err.MODEL_UNAVAILABLE": "The model is still loading. Please wait.",
        "err.EMAIL_TAKEN": "That email is already registered",
        "err.INVALID_CREDENTIALS": "Incorrect email or password",
        "err.SELF_FORBIDDEN": "You cannot change or delete your own account",
        "err.LAST_STAFF": "At least one staff account must remain",
        "err.UNKNOWN": "An unknown error occurred",

        "settings.title": "Settings", "settings.lang": "Language",
        "settings.notes": "Personal notes",
        "settings.notesPh": "Jot down prompt ideas — saved automatically",
        "settings.saved": "Saved", "settings.reset": "Clear all data",
        "settings.resetOk": "All data cleared",
        "settings.syncFail": "Could not sync to server (saved locally)",

        "tabs.title": "Manage tabs",
        "tabs.desc": "Choose which tabs to show and reorder them.",
        "tabs.min": "At least one tab must stay visible",

        "gate.desc": "You must sign in before using any feature.",
        "auth.title": "Sign in", "auth.titleReg": "Create account",
        "auth.name": "Display name", "auth.email": "Email", "auth.pass": "Password",
        "auth.login": "Sign in", "auth.register": "Create account",
        "auth.working": "Working...",
        "auth.toReg": "No account? Sign up", "auth.toLogin": "Have an account? Sign in",
        "auth.required": "🔒 Please sign in to continue",
        "auth.expired": "Your session has expired. Please sign in again.",
        "auth.errFields": "Please fill in every field",
        "auth.errEmail": "Invalid email format",
        "auth.errShort": "Password must be at least 8 characters",
        "auth.errWeak": "Password must contain both letters and numbers",
        "auth.welcome": "Welcome, {name}",
        "auth.mockNote": "🧪 Accounts are stored locally (mock) — no backend yet",
        "auth.seedNote": "🔑 Demo staff account — {email} / {pass}",
        "badge.mock": "🧪 MOCK MODE — backend not connected",
        "common.close": "Close", "common.cancel": "Cancel",

        "admin.title": "Staff Console",
        "admin.subtitle": "Manage user accounts and access rights",
        "admin.back": "Back to app",
        "admin.signedAs": "Signed in as",
        "admin.denied": "Access denied",
        "admin.deniedDesc": "This page is for staff only. Your account role is “{role}”.",
        "admin.warn": "⚠️ This check runs client-side only — a real system must verify again on the server.",
        "admin.statTotal": "Total users",
        "admin.statStaff": "Staff",
        "admin.statUser": "Regular users",
        "admin.statSize": "Storage used",
        "admin.search": "Search name or email...",
        "admin.export": "Export JSON",
        "admin.refresh": "Reload",
        "admin.loading": "Loading...",
        "admin.colName": "Name",
        "admin.colEmail": "Email",
        "admin.colRole": "Role",
        "admin.colCreated": "Created",
        "admin.colActions": "Actions",
        "admin.promote": "Promote to staff",
        "admin.demote": "Demote to user",
        "admin.delete": "Delete",
        "admin.you": "you",
        "admin.empty": "No users match your search",
        "admin.confirmDelete": "Delete account {email} ?\n\nTheir personal notes and tab settings will be removed too.",
        "admin.msgRole": "Changed role of {email} to “{role}”",
        "admin.msgDeleted": "Deleted account {email}",
        "admin.msgExport": "Exported (password hashes excluded)",
    },
};

/* ---------- แท็บทั้งหมด ---------- */
const TAB_ORDER = ["genimage", "back", "icon", "tone", "blur"];

const TAB_CONFIG = {
    genimage: {
        label: "GenImage", type: "text2img",
        usesPrompt: true, needsFile: false,
        endpoint: "/api/v1/generate", contentType: "application/json",
        cta: { th: "สร้างภาพ", en: "Generate" },
        hint: { th: "อธิบายภาพที่ต้องการให้ละเอียด", en: "Describe your image in detail" },
        returns: "image/png",
        fields: {},
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
    blur: {
        label: "Blur", type: "img2img",
        usesPrompt: false, needsFile: true,
        endpoint: "/api/v1/blur", contentType: "multipart/form-data",
        cta: { th: "เบลอภาพ", en: "Apply Blur" },
        hint: { th: "PNG / JPG / WEBP · ไม่เกิน 20 MB", en: "PNG / JPG / WEBP · max 20 MB" },
        accept: ["image/png", "image/jpeg", "image/webp"], maxMB: 20,
        /* PNG เพราะโหมดโมเสกมีขอบคม ถ้าใช้ JPEG จะเกิดรอยหยักรอบบล็อก */
        returns: "image/png",
        fields: {
            blur_type: {
                kind: "enum", label: { th: "รูปแบบการเบลอ", en: "Blur type" }, default: "gaussian",
                values: [
                    { v: "gaussian", th: "ทั้งภาพ", en: "Gaussian" },
                    { v: "background", th: "เฉพาะพื้นหลัง", en: "Background" },
                    { v: "face", th: "เฉพาะใบหน้า", en: "Face" },
                    { v: "motion", th: "เคลื่อนไหว", en: "Motion" },
                    { v: "pixelate", th: "โมเสก", en: "Pixelate" },
                    { v: "radial", th: "รัศมี", en: "Radial" },
                ],
            },
            blur_amount: {
                kind: "range", label: { th: "ความเบลอ", en: "Blur amount" },
                min: 0, max: 100, step: 5, default: 40, suffix: "%",
            },
        },
    },
}; 