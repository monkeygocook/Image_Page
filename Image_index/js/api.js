/* ============================================================
   api.js — ชั้นเชื่อมต่อภายนอกทั้งหมด (Service Layer)

   กฎเหล็ก 2 ข้อ:
   1) มีเพียงไฟล์นี้ไฟล์เดียวในระบบที่เรียก fetch() ได้
   2) ทุกเมธอดต้องมี 2 ทาง — mock (จำลอง) และ live (Backend จริง)
      โดยหน้าตา input/output ต้องเหมือนกันเป๊ะ

   ผลลัพธ์: เปลี่ยน API_MODE บรรทัดเดียว ระบบสลับโหมดได้ทันที
            โดย script.js และ admin.js ไม่ต้องแก้อะไรเลย

   เส้นทางข้อมูล Frontend → Backend (โหมด live):
   UI ใน script.js/admin.js เรียกเมธอดใน Api → เมธอดเตรียมข้อมูลและเรียก
   request() → fetch(API_BASE + path) ส่ง HTTP ไปยัง Backend → แปลงคำตอบ
   เป็นข้อมูล/ข้อผิดพลาดแล้วส่งกลับให้ UI ส่วนโหมด mock จะใช้ localStorage
   หรือ canvas ในเบราว์เซอร์แทนการส่ง request ไป Backend
   ============================================================ */

/**
 * ข้อผิดพลาดมาตรฐานของ API ที่ส่งกลับให้ UI
 * รับ code, ข้อความ message และข้อมูลเสริม meta เช่น HTTP status/requestId
 * เพื่อให้ UI แสดงข้อความได้ตรงประเภทและใช้ requestId ตรวจสอบ log ได้
 */
class ApiError extends Error {
    constructor(code, message, meta = {}) {
        super(message || code);
        this.name = "ApiError";
        this.code = code;                       // เช่น "NETWORK", "RATE_LIMITED"
        this.status = meta.status || 0;         // HTTP status
        this.requestId = meta.requestId || null;// X-Request-Id สำหรับไล่ log
        this.retryAfter = meta.retryAfter || 0; // วินาทีที่ต้องรอ (429)
    }
}

const Api = (() => {

    /* ========================================================
       ส่วนที่ 1 — สถานะการเชื่อมต่อ
       ======================================================== */
    // mode คือ mock/live, online คือสถานะ Backend และ ready บอกว่า init() เสร็จแล้ว
    let mode = API_MODE === "live" ? "live" : "mock";
    let online = API_MODE === "mock";
    let ready = false;
    let lastRequestId = null;
    let pollTimer = null;

    const statusFns = new Set();
    let unauthorizedFn = null;

    const isMock = () => mode === "mock";
    const isLive = () => mode === "live";
    const isOnline = () => (isMock() ? true : online);

    // แจ้งผู้สมัครรับสถานะทุกครั้งที่ mode/online/ready เปลี่ยน
    function emit() {
        const s = { mode, online: isOnline(), ready };
        statusFns.forEach((fn) => { try { fn(s); } catch { } });
    }
    // อัปเดตสถานะเครือข่ายและแจ้ง UI เฉพาะเมื่อค่าเปลี่ยน
    function setOnline(v) { if (online !== v) { online = v; emit(); } }

    /* ========================================================
       ส่วนที่ 2 — Token & Session (ใช้ร่วมทั้ง 2 โหมด)
       ======================================================== */
    // Token เก็บ access token สำหรับแนบ Authorization header ใน request()
    const Token = {
        get: () => localStorage.getItem(STORE + "token"),
        set: (v) => v
            ? localStorage.setItem(STORE + "token", v)
            : localStorage.removeItem(STORE + "token"),
    };

    let expiredFlag = false;

    // Session เก็บข้อมูลผู้ใช้/วันหมดอายุใน localStorage; u คือข้อมูลผู้ใช้จากการเข้าสู่ระบบ
    const Session = {
        /** อ่าน session พร้อมตรวจวันหมดอายุ — คืน null ถ้าหมดอายุแล้ว */
        load() {
            let raw = null;
            try { raw = JSON.parse(localStorage.getItem(STORE + "session") || "null"); } catch { }
            if (!raw) return null;
            if (typeof raw.exp === "number" && Date.now() > raw.exp) {
                Session.clear();
                expiredFlag = true;
                return null;
            }
            return raw;
        },
        /** บันทึก session พร้อมประทับเวลาหมดอายุ */
        save(u, token = null) {
            const withExp = { ...u, exp: Date.now() + SESSION_TTL_HOURS * 3600 * 1000 };
            localStorage.setItem(STORE + "session", JSON.stringify(withExp));
            if (token) Token.set(token);
            expiredFlag = false;
            return withExp;
        },
        clear() {
            localStorage.removeItem(STORE + "session");
            Token.set(null);
        },
        wasExpired: () => expiredFlag,
        ackExpired: () => { expiredFlag = false; },
    };

    // สร้างคีย์ localStorage แยกข้อมูลตามอีเมลผู้ใช้; k คือชื่อข้อมูล เช่น notes
    const owner = () => Session.load()?.email || "guest";
    const uKey = (k) => `${STORE}${owner()}:${k}`;

    /* ========================================================
       ส่วนที่ 3 — ตัวส่ง request ระดับล่าง (โหมด live เท่านั้น)
       ======================================================== */
    // หน่วงเวลา ms มิลลิวินาที และยกเลิกการรอได้ด้วย AbortSignal (signal)
    const sleep = (ms, signal) => new Promise((resolve, reject) => {
        const id = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(id);
            const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        }, { once: true });
    });

    /**
     * จุดส่ง HTTP request กลางสำหรับ Backend
     * path คือ endpoint; opts รับ method/body/headers/signal/auth/expect,
     * timeout และจำนวน retry แล้วคืน JSON, Blob หรือ null ตาม expect
     */
    async function request(path, opts = {}) {
        const {
            method = "GET", body, headers = {}, signal, auth = true,
            expect = "json", timeout = REQUEST_TIMEOUT, retry = NET_RETRY,
        } = opts;

        const h = new Headers(headers);
        if (auth && Token.get()) h.set("Authorization", `Bearer ${Token.get()}`);

        /* ผูก signal ของผู้เรียก เข้ากับ timeout ของเราเอง
           แยก "หมดเวลา" ออกจาก "ผู้ใช้กดยกเลิก" ด้วยตัวแปร cause */
        const ctrl = new AbortController();
        let cause = null;
        const relay = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener("abort", relay, { once: true });
        }
        const timer = setTimeout(() => { cause = "timeout"; ctrl.abort(); }, timeout);

        let res;
        try {
            res = await fetch(API_BASE + path, { method, body, headers: h, signal: ctrl.signal });
        } catch (e) {
            if (cause === "timeout") throw new ApiError("TIMEOUT", "request timed out");
            if (ctrl.signal.aborted) { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
            setOnline(false);
            // เน็ตสะดุดชั่วคราว → ลองซ้ำได้เฉพาะ GET (ปลอดภัยเพราะไม่เปลี่ยนข้อมูล)
            if (retry > 0 && method === "GET") return request(path, { ...opts, retry: retry - 1 });
            throw new ApiError("NETWORK", e.message);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", relay);
        }

        lastRequestId = res.headers.get("X-Request-Id");
        setOnline(true);

        if (!res.ok) {
            let code = "UNKNOWN";
            let msg = `HTTP ${res.status}`;
            try {
                const j = await res.json();
                code = j?.error?.code || code;
                msg = j?.error?.message || msg;
            } catch { }

            if (code === "UNKNOWN") {
                code = { 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 413: "FILE_TOO_LARGE", 429: "RATE_LIMITED", 500: "INTERNAL_ERROR", 503: "MODEL_UNAVAILABLE" }[res.status] || "UNKNOWN";
            }

            const err = new ApiError(code, msg, {
                status: res.status,
                requestId: lastRequestId,
                retryAfter: Number(res.headers.get("Retry-After") || 0),
            });

            if (res.status === 401) {
                Session.clear();
                if (unauthorizedFn) { try { unauthorizedFn(err); } catch { } }
            }
            throw err;
        }

        if (expect === "blob") return res.blob();
        if (expect === "none" || res.status === 204) return null;
        try { return await res.json(); } catch { return null; }
    }

    /* ========================================================
       ส่วนที่ 4 — คลังข้อมูลจำลอง (mock)
       ======================================================== */
    // อ่านรายชื่อผู้ใช้จำลองจาก localStorage; คืน array ว่างเมื่อไม่มี/อ่านข้อมูลไม่ได้
    const mockUsers = () => {
        try { return JSON.parse(localStorage.getItem(STORE + "users") || "[]"); }
        catch { return []; }
    };
    // บันทึกรายชื่อผู้ใช้จำลอง list กลับลง localStorage
    const saveMockUsers = (list) => localStorage.setItem(STORE + "users", JSON.stringify(list));

    /* ⚠️ djb2 ไม่ใช่ cryptographic hash — ใช้ได้เฉพาะโหมด mock
       ระบบจริงต้องแฮชที่หลังบ้านด้วย argon2id หรือ bcrypt (cost >= 12)
       การแฮชฝั่ง client ไม่ช่วยความปลอดภัยเลย เพราะโค้ดเปิดให้อ่านได้ทุกคน */
    // แปลงข้อความ s เป็นค่า hash อย่างง่ายสำหรับจำลองรหัสผ่านใน mock เท่านั้น
    const weakHash = (s) => {
        let h = 5381;
        for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
        return h.toString(16);
    };

    /* ไม่สร้างบัญชีเจ้าหน้าที่ตั้งต้น */
    // เตรียมข้อมูลเจ้าหน้าที่เริ่มต้นใน mock (ไม่ทำงานเมื่อเป็น public mode)
    function ensureSeedStaff() {
        if (PUBLIC_MODE) return;        // ไม่สร้างบัญชีเจ้าหน้าที่ตั้งต้น
        const list = mockUsers();
        // ...(ส่วนที่เหลือคงเดิม)
    }

    // กรองข้อมูลบัญชี u ให้เหลือเฉพาะฟิลด์ที่อนุญาตให้ UI ใช้/แสดง
    const publicUser = (u) => ({
        name: u.name, email: u.email,
        role: PUBLIC_MODE ? "user" : (u.role || "user"),   // บังคับ user เสมอ
        created_at: u.created_at,
    });

    /* ========================================================
       ส่วนที่ 5 — เครื่องจำลองการประมวลผลภาพด้วย canvas
       (ทำหน้าที่แทน Backend ในโหมด mock)
       ======================================================== */
    // โหลดภาพจาก src (เช่น URL preview) เป็น Image element; reject เมื่อถอดรหัสไม่ได้
    function loadImageEl(src) {
        return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new ApiError("UNPROCESSABLE_IMAGE", "decode failed"));
            im.src = src;
        });
    }

    // แปลง canvas cv เป็น Blob URL สำหรับแสดง/ดาวน์โหลด; mime ระบุชนิดไฟล์ผลลัพธ์
    function canvasToBlobURL(cv, mime) {
        return new Promise((resolve, reject) => {
            cv.toBlob(
                (blob) => blob
                    ? resolve(URL.createObjectURL(blob))
                    : reject(new ApiError("EXPORT_FAILED", "toBlob returned null")),
                mime || "image/png",
                0.92
            );
        });
    }

    /** Tone — filter string ที่ผันตามสไลเดอร์ความเข้ม */
    // สร้าง CSS filter ตามตัวเลือก o.tone และระดับ o.strength (0–100)
    function toneFilter(o) {
        const s = Math.min(1, Math.max(0, Number(o.strength ?? 70) / 100));
        return {
            warm: `sepia(${0.55 * s}) saturate(${1 + 0.45 * s})`,
            cool: `hue-rotate(${200 * s}deg) saturate(${1 + 0.25 * s})`,
            pastel: `saturate(${1 - 0.45 * s}) brightness(${1 + 0.12 * s})`,
            mono: `grayscale(${s})`,
            vivid: `saturate(${1 + 0.9 * s}) contrast(${1 + 0.25 * s})`,
            cinematic: `contrast(${1 + 0.35 * s}) sepia(${0.35 * s}) saturate(${1 - 0.1 * s})`,
        }[o.tone] || "none";
    }

    /** Back — จำลองการตัดพื้นหลัง (ของจริงใช้โมเดล segmentation) */
    // จำลองการตัดพื้นหลังบน canvas: ctx คือบริบทวาด, img คือภาพ, w/h คือขนาด, o.output คือสีพื้นหลัง
    function drawBackMock(ctx, img, w, h, o) {
        const out = o.output || "transparent";
        if (out !== "transparent") {
            ctx.fillStyle = out === "white" ? "#ffffff" : "#000000";
            ctx.fillRect(0, 0, w, h);
        }
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(w / 2, h * 0.52, w * 0.32, h * 0.44, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
    }

    /** Blur — เบลอ 6 รูปแบบ ผันตามสไลเดอร์ความเบลอ */
    // จำลองเอฟเฟกต์เบลอบน canvas โดยรับชนิด o.blur_type และระดับ o.blur_amount
    function drawBlurMock(ctx, img, w, h, o) {
        const amt = Math.min(100, Math.max(0, Number(o.blur_amount ?? 40)));
        const px = Math.max(1, Math.round((amt / 100) * 26));
        const type = o.blur_type || "gaussian";
        const over = px + 2;   // วาดล้นขอบ กันขอบภาพจางจากการเบลอ

        if (type === "pixelate") {
            const factor = Math.max(2, Math.round(amt / 2) + 2);
            const tw = Math.max(1, Math.round(w / factor));
            const th = Math.max(1, Math.round(h / factor));
            const tmp = document.createElement("canvas");
            tmp.width = tw; tmp.height = th;
            tmp.getContext("2d").drawImage(img, 0, 0, tw, th);
            ctx.imageSmoothingEnabled = false;      // หัวใจของโมเสก
            ctx.drawImage(tmp, 0, 0, w, h);
            ctx.imageSmoothingEnabled = true;
            return;
        }

        if (type === "motion") {
            const steps = 14;
            const span = px * 2;
            ctx.globalAlpha = 1 / steps;
            for (let i = 0; i < steps; i++) {
                ctx.drawImage(img, (i / (steps - 1) - 0.5) * span, 0, w, h);
            }
            ctx.globalAlpha = 1;
            return;
        }

        if (type === "face") {
            ctx.drawImage(img, 0, 0, w, h);
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(w / 2, h * 0.30, w * 0.17, h * 0.22, 0, 0, Math.PI * 2);
            ctx.clip();
            ctx.filter = `blur(${Math.max(8, px)}px)`;
            ctx.drawImage(img, -over, -over, w + over * 2, h + over * 2);
            ctx.filter = "none";
            ctx.restore();
            return;
        }

        ctx.filter = `blur(${px}px)`;
        ctx.drawImage(img, -over, -over, w + over * 2, h + over * 2);
        ctx.filter = "none";
        if (type === "gaussian") return;

        ctx.save();
        ctx.beginPath();
        if (type === "background") ctx.ellipse(w / 2, h * 0.52, w * 0.30, h * 0.42, 0, 0, Math.PI * 2);
        else ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.34, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
    }

    /**
     * ประมวลผลภาพในเบราว์เซอร์แทน Backend สำหรับ mock
     * รับ tab/cfg/options, URL ภาพต้นฉบับ previewUrl และ signal สำหรับยกเลิก
     * คืน URL ภาพจำลอง (หรือ URL placeholder สำหรับ text-to-image)
     */
    async function mockProcessImage({ tab, cfg, options = {}, previewUrl, signal }) {
        await sleep(MOCK_DELAY_MS, signal);

        if (cfg.type === "text2img") {
            const [w, h] = (options.size || "1024x1024").split("x");
            // ".png" สำคัญมาก ถ้าไม่ใส่ placehold.co จะส่ง SVG มาให้
            return `https://placehold.co/${w}x${h}/1f2937/94a3b8.png?text=MOCK+GenImage`;
        }

        if (!previewUrl) throw new ApiError("VALIDATION_ERROR", "no source image");

        const img = await loadImageEl(previewUrl);
        const long = Math.max(img.naturalWidth, img.naturalHeight) || 1;
        const scale = Math.min(1, MOCK_MAX_SIDE / long);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");

        if (tab === "blur") drawBlurMock(ctx, img, w, h, options);
        else if (tab === "back") drawBackMock(ctx, img, w, h, options);
        else {
            ctx.filter = tab === "tone" ? toneFilter(options) : "saturate(1.06) contrast(1.04) blur(0.4px)";
            ctx.drawImage(img, 0, 0, w, h);
            ctx.filter = "none";
        }

        return canvasToBlobURL(cv, cfg.returns);
    }

    /* ========================================================
       ส่วนที่ 6 — เมธอดสาธารณะ (UI เรียกใช้ผ่านตรงนี้เท่านั้น)
       ======================================================== */

    /**
     * ตรวจสุขภาพ Backend ผ่าน GET health endpoint (ยกเว้น mock)
     * ไม่รับ input; คืนข้อมูลสถานะ หรือ null เมื่อติดต่อ Backend ไม่ได้
     */
    async function ping() {
        if (API_MODE === "mock") { setOnline(true); return { status: "mock" }; }
        try {
            const j = await request(ENDPOINTS.health, {
                auth: false, timeout: HEALTH_TIMEOUT, retry: 0,
            });
            setOnline(true);
            return j || { status: "ok" };
        } catch {
            setOnline(false);
            return null;
        }
    }

    // เริ่มตรวจสถานะ Backend ซ้ำทุก HEALTH_INTERVAL มิลลิวินาที
    function startPolling() {
        stopPolling();
        pollTimer = setInterval(ping, HEALTH_INTERVAL);
    }
    // หยุด timer ที่ใช้ตรวจสถานะ Backend
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /**
     * เรียกตอนเปิดหน้าเพื่อเลือก mock/live/auto และเตรียมสถานะการเชื่อมต่อ
     * คืน { mode, online }; ใน auto จะเลือก live เมื่อ Backend ตอบ health ได้
     */
    async function init() {
        if (API_MODE === "mock") {
            mode = "mock"; online = true;
        } else if (API_MODE === "live") {
            mode = "live";
            await ping();
            startPolling();
        } else {                                  // auto
            const h = await ping();
            mode = h ? "live" : "mock";
            online = !!h;
            if (mode === "live") startPolling();
            else online = true;
        }
        if (mode === "mock") ensureSeedStaff();
        ready = true;
        emit();
        return { mode, online: isOnline() };
    }

    /* ---------- Authentication ---------- */
    // เมธอดบัญชีผู้ใช้: UI ส่งข้อมูลเข้าเมธอดเหล่านี้; live จะส่ง JSON ไป Backend
    const auth = {
        // สมัครสมาชิกด้วย name/email/password; คืน user ที่เปิดเผยได้และ access_token
        async register({ name, email, password }) {
            if (isMock()) {
                await sleep(350);
                const list = mockUsers();
                if (list.some((u) => u.email === email)) throw new ApiError("EMAIL_TAKEN");
                const rec = {
                    name, email, pw: weakHash(password), role: "user",
                    created_at: new Date().toISOString(),
                };
                list.push(rec);
                saveMockUsers(list);
                return { user: publicUser(rec), access_token: "mock." + weakHash(email) };
            }
            const j = await request(ENDPOINTS.register, {
                method: "POST", auth: false,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, password }),
            });
            return { user: j.user, access_token: j.access_token };
        },

        // เข้าสู่ระบบด้วย email/password; คืน user และ access_token หรือแจ้งข้อมูลรับรองไม่ถูกต้อง
        async login({ email, password }) {
            if (isMock()) {
                await sleep(350);
                const found = mockUsers().find((u) => u.email === email);
                // ข้อความต้องคลุมเครือเหมือนกันทั้ง 2 กรณี กัน user enumeration
                if (!found || found.pw !== weakHash(password)) throw new ApiError("INVALID_CREDENTIALS");
                return { user: publicUser(found), access_token: "mock." + weakHash(email) };
            }
            const j = await request(ENDPOINTS.login, {
                method: "POST", auth: false,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            return { user: j.user, access_token: j.access_token };
        },

        /** ตรวจว่า token ที่เก็บไว้ยังใช้ได้ไหม (ใช้ตอนเปิดหน้าในโหมด live) */
        // ตรวจสอบตัวตนจาก session/token ปัจจุบัน; live เรียก endpoint /me
        async me() {
            if (isMock()) {
                const s = Session.load();
                if (!s) throw new ApiError("UNAUTHORIZED");
                return { user: publicUser(s) };
            }
            return request(ENDPOINTS.me);
        },

        // ออกจากระบบ: แจ้ง Backend ใน live (ถ้ามี token) แล้วล้าง session/token ในเครื่อง
        async logout() {
            if (isLive() && Token.get()) {
                try { await request(ENDPOINTS.logout, { method: "POST", expect: "none", retry: 0 }); }
                catch { /* ออกจากระบบฝั่งเราให้สำเร็จเสมอ ไม่ว่าเซิร์ฟเวอร์จะตอบอะไร */ }
            }
            Session.clear();
        },
    };

    /* ---------- ข้อมูลส่วนตัวของผู้ใช้ ---------- */
    // อ่าน/บันทึกข้อมูลส่วนตัว; mock ใช้ localStorage ส่วน live เรียก Backend
    const userData = {
        // อ่านบันทึกของผู้ใช้ปัจจุบัน; คืนข้อความ content (ว่างเมื่อไม่มีข้อมูล)
        async getNotes() {
            if (isMock()) return localStorage.getItem(uKey("notes")) || "";
            const j = await request(ENDPOINTS.notes);
            return j?.content || "";
        },
        // บันทึก content ในเครื่องก่อน แล้วใน live ส่ง { content } แบบ PUT ไป Backend
        async saveNotes(content) {
            localStorage.setItem(uKey("notes"), content);   // เขียนในเครื่องก่อนเสมอ (ตอบสนองทันที)
            if (isMock()) return true;
            await request(ENDPOINTS.notes, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            });
            return true;
        },
        // อ่านภาษาและการจัดแท็บ; live ขอค่าจาก Backend และใช้ค่าท้องถิ่นสำรองเมื่อเรียกไม่สำเร็จ
        async getPreferences() {
            const local = {
                lang: localStorage.getItem(STORE + "lang") || "th",
                tabs: JSON.parse(localStorage.getItem(uKey("tabs")) || "null"),
            };
            if (isMock()) return local;
            try {
                const j = await request(ENDPOINTS.preferences);
                return { lang: j?.lang || local.lang, tabs: j?.tabs || local.tabs };
            } catch {
                return local;                                // เซิร์ฟเวอร์ล่ม → ใช้ของในเครื่อง
            }
        },
        // บันทึก lang และ/หรือ tabs; เก็บสำเนาใน localStorage และส่ง JSON แบบ PUT ใน live
        async savePreferences({ lang, tabs }) {
            if (lang) localStorage.setItem(STORE + "lang", lang);
            if (tabs) localStorage.setItem(uKey("tabs"), JSON.stringify(tabs));
            if (isMock()) return true;
            await request(ENDPOINTS.preferences, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lang, tabs }),
            });
            return true;
        },
    };

    /* ---------- ประมวลผลภาพ ---------- */
    // เตรียม body/headers ตามรูปแบบ endpoint: JSON สำหรับ prompt หรือ FormData สำหรับไฟล์ภาพ
    function buildBody({ cfg, file, prompt, negative, options = {} }) {
        if (cfg.contentType === "application/json") {
            const p = (prompt || "").trim();
            if (cfg.usesPrompt && !p) throw new ApiError("VALIDATION_ERROR", "กรุณากรอกคำอธิบายภาพ");
            const payload = { prompt: p, ...options };
            if (negative && negative.trim()) payload.negative_prompt = negative.trim();
            return { body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } };
        }
        if (!file) throw new ApiError("VALIDATION_ERROR", "กรุณาเลือกไฟล์ภาพก่อน");
        const fd = new FormData();
        fd.append("image", file, file.name);
        for (const [k, v] of Object.entries(options)) fd.append(k, String(v));
        return { body: fd, headers: {} };   // ห้ามตั้ง Content-Type เอง
    }
    const image = {
        /**
         * ส่งคำขอประมวลผลภาพจาก Frontend ไป Backend (POST cfg.endpoint)
         * รับ tab/cfg, file หรือ prompt/negative, options, previewUrl, signal และ requestId
         * JSON ใช้กับงาน prompt; FormData ใช้แนบไฟล์ชื่อ image พร้อม options
         * @returns {Promise<string>} URL ของภาพผลลัพธ์ (blob: หรือ http:)
         */
        async process({ tab, cfg, file, prompt, negative, options = {}, previewUrl, signal, requestId }) {
            // requestId ใช้ผูกคำขอกับ log ฝั่ง Backend เพื่อช่วยติดตามปัญหา
            let headers = {};

            if (requestId) headers["X-Request-ID"] = requestId;
            /*
            // บล็อก mock นี้ถูกปิดไว้; ปัจจุบัน process() จึงเรียก Backend ผ่าน request() เสมอ
            // หากเปิดใช้ mock ต้องยกเลิกคอมเมนต์เพื่อใช้เครื่องจำลอง canvas ในส่วนที่ 5
            if (isMock()) return mockProcessImage({ tab, cfg, options, previewUrl, signal });

            let body, headers; */

            if (cfg.contentType === "application/json") {
                const p = (prompt || "").trim();
                if (cfg.usesPrompt && !p) throw new ApiError("VALIDATION_ERROR", "กรุณากรอกคำอธิบายภาพ");
                const payload = { prompt: p, ...options };
                if (negative && negative.trim()) payload.negative_prompt = negative.trim();
                headers = { "Content-Type": "application/json" };
                body = JSON.stringify(payload);
            } else {
                if (!file) throw new ApiError("VALIDATION_ERROR", "กรุณาเลือกไฟล์ภาพก่อน");
                const fd = new FormData();
                fd.append("image", file, file.name);
                for (const [k, v] of Object.entries(options)) fd.append(k, String(v));
                body = fd;   // ห้ามตั้ง Content-Type เอง — เบราว์เซอร์ต้องเติม boundary
            }

            const blob = await request(cfg.endpoint, {
                method: "POST", body, headers, signal,
                expect: "blob", retry: 0, timeout: PROCESS_TIMEOUT,
            });

            if (!blob || !blob.type.startsWith("image/")) {
                throw new ApiError(
                    "UNPROCESSABLE_IMAGE",
                    `เซิร์ฟเวอร์ไม่ได้ส่งไฟล์ภาพกลับมา (${blob?.type || "unknown"})`
                );
            }
            return URL.createObjectURL(blob);
        },

        /**
         * ส่งงานภาพแบบ asynchronous ไป Backend แล้วติดตามสถานะผ่าน SSE
         * รับ cfg/file/prompt/negative/options และ signal; onStatus รับข้อมูลสถานะ
         * เริ่มด้วย POST jobs, ยกเลิกด้วย DELETE, รับ event จน done/error/cancelled
         * แล้วดาวน์โหลดผลลัพธ์เป็น Blob URL ให้ UI
         */
        async processJob({ cfg, file, prompt, negative, options = {}, signal, onStatus }) {
            // Frontend ส่งข้อมูลเริ่มงานไป Backend; name มาจากชื่อ endpoint ของฟังก์ชันภาพ
            const { body, headers } = buildBody({ cfg, file, prompt, negative, options });
            const name = cfg.endpoint.split("/").pop();
            const job = await request(`/api/v1/jobs/${name}`, { method: "POST", body, headers, signal, retry: 0 });
            onStatus?.(job);

            const onAbort = () => fetch(API_BASE + `/api/v1/jobs/${job.job_id}`,
                { method: "DELETE", headers: { Authorization: `Bearer ${Token.get()}` } }).catch(() => { });
            signal?.addEventListener("abort", onAbort, { once: true });

            const res = await fetch(API_BASE + `/api/v1/jobs/${job.job_id}/events`, {
                headers: { Authorization: `Bearer ${Token.get()}` }, signal,
            });
            if (!res.ok) throw new ApiError("INTERNAL_ERROR", `HTTP ${res.status}`, { status: res.status });

            const reader = res.body.getReader(), dec = new TextDecoder();
            let buf = "", final = null;
            while (!final) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
                    if (!line) continue;                       // heartbeat
                    const s = JSON.parse(line.slice(6));
                    onStatus?.(s);
                    if (["done", "error", "cancelled"].includes(s.status)) final = s;
                }
            }
            signal?.removeEventListener("abort", onAbort);
            if (!final || final.status === "cancelled") { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
            if (final.status === "error") throw new ApiError(final.error.code, final.error.message);

            const blob = await request(`/api/v1/jobs/${job.job_id}/result`, { expect: "blob", retry: 0 });
            return URL.createObjectURL(blob);
        },
    };

    /* ---------- งานเจ้าหน้าที่ ---------- */
    // เมธอดจัดการบัญชีสำหรับหน้าผู้ดูแล; live ส่งคำขอไปยัง admin endpoints ของ Backend
    const admin = {
        /** รับบัญชี u แล้วคืนคีย์อ้างอิง; Backend ใช้ id ส่วน mock ใช้อีเมล */
        keyOf: (u) => u.id ?? u.email,

        // ดึงรายชื่อผู้ใช้ทั้งหมด; คืน array ของข้อมูลผู้ใช้ที่เปิดเผยได้
        async list() {
            if (PUBLIC_MODE) throw new ApiError("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
            if (isMock()) {
                await sleep(150);
                return mockUsers().map(publicUser);
            }
            const j = await request(ENDPOINTS.adminUsers);
            return Array.isArray(j) ? j : (j?.users || []);
        },

        // เปลี่ยนบทบาทบัญชี key เป็น role; live ส่ง PATCH พร้อม JSON { role }
        async setRole(key, role) {
            if (PUBLIC_MODE) throw new ApiError("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
            if (isMock()) {
                await sleep(150);
                const meNow = Session.load();
                if (meNow && key === meNow.email) throw new ApiError("SELF_FORBIDDEN");
                const list = mockUsers();
                const target = list.find((u) => u.email === key);
                if (!target) throw new ApiError("NOT_FOUND");
                const staffLeft = list.filter((u) => u.role === "staff").length;
                if (target.role === "staff" && role !== "staff" && staffLeft <= 1) {
                    throw new ApiError("LAST_STAFF");
                }
                target.role = role;
                saveMockUsers(list);
                return publicUser(target);
            }
            const j = await request(ENDPOINTS.adminUserRole(key), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role }),
            });
            return j?.user || j;
        },

        // ลบบัญชี key; live ส่ง DELETE และคืน true เมื่อสำเร็จ
        async remove(key) {
            if (PUBLIC_MODE) throw new ApiError("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
            if (isMock()) {
                await sleep(150);
                const meNow = Session.load();
                if (meNow && key === meNow.email) throw new ApiError("SELF_FORBIDDEN");
                const list = mockUsers();
                const target = list.find((u) => u.email === key);
                if (!target) throw new ApiError("NOT_FOUND");
                const staffLeft = list.filter((u) => u.role === "staff").length;
                if (target.role === "staff" && staffLeft <= 1) throw new ApiError("LAST_STAFF");

                saveMockUsers(list.filter((u) => u.email !== key));
                // ลบข้อมูลส่วนตัวที่ผูกกับอีเมลนี้ด้วย
                [`${STORE}${key}:notes`, `${STORE}${key}:tabs`].forEach((k) => localStorage.removeItem(k));
                return true;
            }
            await request(ENDPOINTS.adminUser(key), { method: "DELETE", expect: "none" });
            return true;
        },
    };

    /* ---------- ล้างข้อมูลทั้งหมดในเครื่อง ---------- */
    // ลบ localStorage เฉพาะรายการที่ขึ้นต้นด้วย STORE; ไม่ได้ลบข้อมูลบน Backend
    function wipeLocal() {
        Object.keys(localStorage)
            .filter((k) => k.startsWith(STORE))
            .forEach((k) => localStorage.removeItem(k));
        if (isMock()) ensureSeedStaff();
    }

    // API สาธารณะที่ script.js/admin.js เรียกใช้; onStatus รับ {mode, online, ready}
    // ส่วน onUnauthorized รับ ApiError เมื่อ Backend ตอบ 401
    return {
        init, ping, startPolling, stopPolling, wipeLocal,
        isMock, isLive, isOnline,
        mode: () => mode, isReady: () => ready,
        base: () => API_BASE,
        lastRequestId: () => lastRequestId,
        onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
        onUnauthorized(fn) { unauthorizedFn = fn; },
        Session, Token,
        auth, user: userData, image, admin,
    };
})();