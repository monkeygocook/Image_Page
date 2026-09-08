/* ============================================================
   script.js — ทั้งหมดของหน้าบ้าน
   อัปเดต: 2026-09-08 (บังคับเข้าสู่ระบบก่อนใช้งานทุกฟังก์ชัน)
   ============================================================ */
const $ = (id) => document.getElementById(id);

/* ============================================================
   0. Blob Registry — 1 URL มีเจ้าของเดียว กัน leak + กัน double-revoke
   slot ที่ใช้: "preview" | "result" | "before"
   ============================================================ */
const Blobs = (() => {
    const slots = new Map();
    const isBlob = (u) => typeof u === "string" && u.startsWith("blob:");
    const sharedWith = (url, except) => [...slots].some(([k, v]) => k !== except && v === url);

    const api = {
        set(slot, url) {
            const old = slots.get(slot);
            // revoke เฉพาะเมื่อ: เป็น blob จริง + ไม่มี slot อื่นใช้อยู่
            if (old && old !== url && isBlob(old) && !sharedWith(old, slot)) URL.revokeObjectURL(old);
            url ? slots.set(slot, url) : slots.delete(slot);
            return url ?? null;
        },
        get: (slot) => slots.get(slot) ?? null,
        clear: (slot) => api.set(slot, null),
        clearAll: () => [...slots.keys()].forEach((k) => api.clear(k)),
        fromFile: (slot, file) => api.set(slot, URL.createObjectURL(file)),
        debug: () => Object.fromEntries(slots),
    };
    return api;
})();

window.addEventListener("pagehide", () => Blobs.clearAll());
window.__blobs = Blobs.debug;   // เปิด console พิมพ์ __blobs() ดูได้ว่าค้างกี่ตัว

/* ============================================================
   0.5 อ่าน session พร้อมตรวจวันหมดอายุ
   ============================================================ */
let sessionExpired = false;

function loadSession() {
    const raw = JSON.parse(localStorage.getItem(STORE + "session") || "null");
    if (!raw) return null;
    // exp = เวลาหมดอายุ (ms) — เลียนแบบ exp claim ของ JWT
    if (typeof raw.exp === "number" && Date.now() > raw.exp) {
        localStorage.removeItem(STORE + "session");
        localStorage.removeItem(STORE + "token");
        sessionExpired = true;
        return null;
    }
    return raw;
}

/* ============================================================
   State — ไม่มีตัวแปรเก็บ URL แล้ว ใช้ getter อ่านจาก Blobs อย่างเดียว
   ============================================================ */
let lang = localStorage.getItem(STORE + "lang") || "th";
let user = loadSession();
let currentTab = null;
let currentFile = null;
let optionState = {};
let tabPrefs = null;
let authMode = "login";

const previewURL = () => Blobs.get("preview");
const resultURL = () => Blobs.get("result");
const beforeURL = () => Blobs.get("before");

/* ---------- ด่านตรวจสิทธิ์ ---------- */
const authRequired = () => REQUIRE_AUTH && !user;

/** ใช้นำหน้าทุกฟังก์ชันที่ต้องล็อกอิน — คืน true แปลว่า "ถูกบล็อก" */
function guardAuth() {
    if (!authRequired()) return false;
    showHint(t("auth.required"));
    openAuth("login");
    return true;
}

/* ---------- i18n ---------- */
const t = (k, vars = {}) =>
    (I18N[lang][k] || k).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? "");
const L = (o) => (typeof o === "string" ? o : o?.[lang] ?? "");

function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $("mockBadge").textContent = t("badge.mock");
    $("popAuthLabel").textContent = user ? t("nav.logout") : t("nav.login");
    $("popName").textContent = user ? user.name : t("nav.guest");
    $("popMail").textContent = user ? user.email : "";
    $("popRole").textContent = user ? t("role." + (user.role || "user")) : "";
    $("popRole").hidden = !user;
    $("avatarText").textContent = user ? user.name.slice(0, 1).toUpperCase() : "?";
    if (!$("authModal").hidden) openAuth(authMode);   // แปลข้อความในกล่องล็อกอินด้วย
    renderTabBar();
    if (currentTab) switchTab(currentTab, true);
}

/* ---------- Storage ต่อผู้ใช้ ---------- */
const uKey = (k) => `${STORE}${user ? user.email : "guest"}:${k}`;

/* ============================================================
   1. Tab bar + ตัวจัดการแท็บ (ดินสอ)
   ============================================================ */
function loadTabPrefs() {
    const saved = JSON.parse(localStorage.getItem(uKey("tabs")) || "null");
    const valid = saved?.filter((x) => TAB_CONFIG[x.id]);
    tabPrefs = valid?.length ? valid : TAB_ORDER.map((id) => ({ id, on: true }));
    TAB_ORDER.forEach((id) => {                       // เผื่อเพิ่มแท็บใหม่ในอนาคต
        if (!tabPrefs.some((x) => x.id === id)) tabPrefs.push({ id, on: true });
    });
}
const saveTabPrefs = () => localStorage.setItem(uKey("tabs"), JSON.stringify(tabPrefs));
const visibleTabs = () => tabPrefs.filter((x) => x.on).map((x) => x.id);

function renderTabBar() {
    const bar = $("tabBar");
    bar.innerHTML = "";
    visibleTabs().forEach((id) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tab" + (id === currentTab ? " active" : "");
        b.textContent = TAB_CONFIG[id].label;
        b.dataset.tab = id;
        b.onclick = () => { if (guardAuth()) return; switchTab(id); };
        bar.appendChild(b);
    });
}

function renderTabManager() {
    const ul = $("tabsList");
    ul.innerHTML = "";
    const onCount = visibleTabs().length;
    tabPrefs.forEach((item, i) => {
        const li = document.createElement("li");
        li.innerHTML = `
      <input type="checkbox" ${item.on ? "checked" : ""} ${item.on && onCount === 1 ? "disabled" : ""}>
      <strong>${TAB_CONFIG[item.id].label}</strong>
      <button type="button" class="mini" ${i === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="mini" ${i === tabPrefs.length - 1 ? "disabled" : ""}>↓</button>`;
        const [chk, , up, down] = li.children;
        chk.onchange = () => {
            item.on = chk.checked;
            commitTabs();
        };
        up.onclick = () => { [tabPrefs[i - 1], tabPrefs[i]] = [tabPrefs[i], tabPrefs[i - 1]]; commitTabs(); };
        down.onclick = () => { [tabPrefs[i + 1], tabPrefs[i]] = [tabPrefs[i], tabPrefs[i + 1]]; commitTabs(); };
        ul.appendChild(li);
    });
    $("tabsWarn").hidden = onCount > 1;
}

function commitTabs() {
    saveTabPrefs();
    renderTabManager();
    renderTabBar();
    if (!visibleTabs().includes(currentTab)) switchTab(visibleTabs()[0]);
}

/* ============================================================
   2. switchTab + renderOptions + สถานะล็อก
   ============================================================ */

/** ชั้นที่ 1+2: เบลอหน้าจอ และปิดการใช้งานทุก control เมื่อยังไม่ล็อกอิน */
function applyLockState() {
    const locked = authRequired();
    const cfg = currentTab ? TAB_CONFIG[currentTab] : null;

    document.body.classList.toggle("locked", locked);

    // ช่อง prompt: ต้องทั้ง "ไม่ล็อก" และ "แท็บนี้ใช้ prompt" ถึงจะพิมพ์ได้
    [$("promptInput"), $("negativeInput")].forEach(
        (el) => (el.disabled = locked || !cfg?.usesPrompt)
    );
    $("clearPrompt").disabled = locked;
    $("fileInput").disabled = locked;
    $("btnClearFile").disabled = locked;
    $("submitBtn").disabled = locked;
    $("btnDownload").disabled = locked || !resultURL();
    $("dropZone").setAttribute("aria-disabled", String(locked));
    $("authClose").hidden = locked;   // ล็อกอยู่ = ห้ามปิดกล่องล็อกอิน
}

/** เรียกทุกครั้งที่สถานะล็อกอินเปลี่ยน */
function refreshAuthState() {
    applyLockState();
    if (authRequired()) openAuth("login");
    else $("authModal").hidden = true;
}

function switchTab(name, keepResult = false) {
    currentTab = name;
    const cfg = TAB_CONFIG[name];

    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

    /* --- Prompt: เฉพาะแท็บที่ใช้จริง --- */
    $("promptGroup").hidden = !cfg.usesPrompt;
    if (!cfg.usesPrompt) { $("promptInput").value = ""; $("negativeInput").value = ""; }

    /* --- Uploader --- */
    $("uploaderGroup").hidden = !cfg.needsFile;
    if (!cfg.needsFile) clearFile();
    $("dzHint").textContent = L(cfg.hint);

    // keepResult = true แปลว่าแค่รีเฟรชภาษา → ต้องคงค่าที่ผู้ใช้เลือกไว้
    renderOptions(cfg, keepResult);
    $("submitBtn").textContent = L(cfg.cta);
    showHint(authRequired() ? t("auth.required") : L(cfg.hint), !authRequired());
    if (!keepResult) clearResult();
    applyLockState();                 // ต้องอยู่หลังสุด เพื่อทับค่า disabled ให้ถูก
    syncURL();
}

function renderOptions(cfg, preserve = false) {
    const prev = preserve ? { ...optionState } : {};
    const box = $("optionsGroup");
    box.innerHTML = "";
    optionState = {};

    Object.entries(cfg.fields || {}).forEach(([key, f]) => {
        const start = prev[key] !== undefined ? prev[key] : f.default;   // คงค่าเดิมถ้ามี
        optionState[key] = start;
        const wrap = document.createElement("div");
        wrap.className = "opt";

        if (f.kind === "enum") {
            wrap.innerHTML = `<span class="opt-label">${L(f.label)}</span><div class="chips"></div>`;
            const chips = wrap.querySelector(".chips");
            f.values.forEach((v) => {
                const c = document.createElement("button");
                c.type = "button";
                c.className = "chip" + (v.v === start ? " on" : "");
                c.textContent = v[lang];
                c.onclick = () => {
                    if (guardAuth()) return;
                    optionState[key] = v.v;
                    chips.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
                    c.classList.add("on");
                };
                chips.appendChild(c);
            });
        } else if (f.kind === "bool") {
            wrap.innerHTML = `<label class="chk"><input type="checkbox" ${start ? "checked" : ""}>
        <span>${L(f.label)}</span></label>`;
            wrap.querySelector("input").onchange = (e) => (optionState[key] = e.target.checked);
        } else if (f.kind === "range") {
            wrap.innerHTML = `<span class="opt-label">${L(f.label)}</span>
        <div class="range-row">
          <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${start}">
          <span class="range-val">${start}${f.suffix || ""}</span>
        </div>`;
            const [inp, out] = [wrap.querySelector("input"), wrap.querySelector(".range-val")];
            inp.oninput = () => { optionState[key] = +inp.value; out.textContent = inp.value + (f.suffix || ""); };
        }
        box.appendChild(wrap);
    });
}

/* ============================================================
   3. ไฟล์อัปโหลด
   ============================================================ */
function setFile(file) {
    if (guardAuth()) return;          // ชั้นที่ 3: กันการลากไฟล์มาวางตอนยังไม่ล็อกอิน
    if (!file) return;
    const cfg = TAB_CONFIG[currentTab];
    if (!cfg.accept?.includes(file.type)) return showHint(t("hint.badType"));
    if (file.size > cfg.maxMB * 1024 * 1024) return showHint(t("hint.tooLarge", { n: cfg.maxMB }));

    clearResult();                                    // ผลลัพธ์เก่าไม่ผูกกับไฟล์ใหม่
    currentFile = file;
    $("thumb").src = Blobs.fromFile("preview", file); // registry ดูแล revoke ให้เอง
    $("fileName").textContent = file.name;
    $("fileSize").textContent = (file.size / 1048576).toFixed(2) + " MB";
    $("dropZone").hidden = true;
    $("filePreview").hidden = false;
    showHint(L(cfg.hint), true);
}

function clearFile() {
    currentFile = null;
    $("fileInput").value = "";
    $("thumb").removeAttribute("src");   // ล้าง src ก่อน revoke เสมอ
    Blobs.clear("preview");              // ถ้า result ยังใช้ URL นี้ → registry จะไม่ revoke
    $("dropZone").hidden = false;
    $("filePreview").hidden = true;
}

/* ============================================================
   4. ผลลัพธ์ / ดาวน์โหลด / เทียบก่อน-หลัง
   ============================================================ */

/* ---------- ตารางแปลง MIME → นามสกุลไฟล์ ---------- */
const MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
};

/**
 * แปลง MIME type เป็นนามสกุลไฟล์
 * @param {string} mime  เช่น "image/png" หรือ "image/svg+xml; charset=utf-8"
 * @param {string} fallback  ใช้เมื่อไม่รู้จัก MIME นั้น
 */
function extFromMime(mime, fallback = "png") {
    const clean = String(mime || "").split(";")[0].trim().toLowerCase();
    return MIME_EXT[clean] || fallback;
}

function clearResult() {
    ["resultImage", "soloImage", "beforeImage"].forEach((id) => $(id).removeAttribute("src"));
    Blobs.clear("result");
    Blobs.clear("before");
    $("compareWrap").hidden = true;
    $("soloImage").hidden = true;
    $("resultEmpty").hidden = false;
    $("compareToggleWrap").hidden = true;
    $("btnDownload").disabled = true;
    $("resultImage").style.filter = $("soloImage").style.filter = "";
}

function showResult(url, beforeSrc) {
    Blobs.set("result", url);
    Blobs.set("before", beforeSrc || null);
    $("resultEmpty").hidden = true;
    $("resultImage").src = url;
    $("soloImage").src = url;
    $("btnDownload").disabled = authRequired();

    const canCompare = !!beforeSrc;
    $("compareToggleWrap").hidden = !canCompare;
    if (canCompare) $("beforeImage").src = beforeSrc;
    paintCompare();
}

function paintCompare() {
    const on = !$("compareToggleWrap").hidden && $("compareToggle").checked;
    $("compareWrap").hidden = !on;
    $("soloImage").hidden = on;
    if (on) $("afterClip").style.clipPath = `inset(0 0 0 ${$("compareRange").value}%)`;
}

$("compareToggle").onchange = paintCompare;
$("compareRange").oninput = paintCompare;

$("btnDownload").onclick = async () => {
    if (guardAuth()) return;
    const url = resultURL();
    if (!url) return;

    // นามสกุลสำรอง = ตามสัญญาใน config (ใช้เมื่ออ่านของจริงไม่ได้)
    const fallbackExt = extFromMime(TAB_CONFIG[currentTab].returns, "png");
    let href = url, temp = null, ext = fallbackExt;

    try {
        // ดึงเป็น blob เสมอ (ทั้ง blob: และ remote) เพื่ออ่าน MIME ของจริง
        const res = await fetch(url, url.startsWith("blob:") ? {} : { mode: "cors" });
        const blob = await res.blob();
        ext = extFromMime(blob.type, fallbackExt);   // ← ใช้ของจริง ไม่ใช่ของที่คาดหวัง
        href = temp = URL.createObjectURL(blob);
    } catch {
        // ดึงไม่ได้ (เช่นโดน CORS) → ใช้ URL เดิม + นามสกุลตามสัญญา
    }

    const name = `${currentTab}-${Date.now()}.${ext}`;
    try {
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch {
        window.open(url, "_blank", "noopener");       // fallback สุดท้าย
    } finally {
        if (temp) setTimeout(() => URL.revokeObjectURL(temp), 4000);
    }
};

/* ============================================================
   5. Validate + Submit
   ============================================================ */
function showHint(msg, info = false) {
    const el = $("hint");
    el.textContent = msg || "";
    el.classList.toggle("info", info);
}

function validate() {
    if (guardAuth()) return false;    // ชั้นที่ 3: ด่านสุดท้ายก่อนยิงงาน
    const cfg = TAB_CONFIG[currentTab];
    if (cfg.usesPrompt && !$("promptInput").value.trim()) {
        showHint(t("hint.needPrompt")); $("promptInput").focus(); return false;
    }
    if (cfg.needsFile && !currentFile) { showHint(t("hint.needFile")); return false; }
    return true;
}

function setBusy(on) {
    $("submitBtn").disabled = on || authRequired();
    $("spinner").hidden = !on;
    if (on) { $("resultEmpty").hidden = true; $("soloImage").hidden = true; $("compareWrap").hidden = true; }
}

$("genForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const cfg = TAB_CONFIG[currentTab];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    clearResult();
    setBusy(true);                                  // เรียกครั้งเดียว หลัง clearResult
    try {
        const url = USE_MOCK ? await mockRequest(cfg) : await realRequest(cfg, controller.signal);
        showResult(url, cfg.needsFile ? previewURL() : null);
        showHint(USE_MOCK ? t("hint.mock") : "", true);
    } catch (err) {
        showHint(err.name === "AbortError" ? t("hint.abort") : t("hint.error", { msg: err.message }));
        $("resultEmpty").hidden = false;
    } finally {
        clearTimeout(timer);
        setBusy(false);
    }
});

/* ============================================================
   5.5 API layer — ใส่ token อัตโนมัติ + จัดการ 401
   ============================================================ */
const Token = {
    get: () => localStorage.getItem(STORE + "token"),
    set: (v) => v
        ? localStorage.setItem(STORE + "token", v)
        : localStorage.removeItem(STORE + "token"),
};

async function apiFetch(path, { auth = true, ...opts } = {}) {
    const headers = new Headers(opts.headers || {});
    if (auth && Token.get()) headers.set("Authorization", `Bearer ${Token.get()}`);

    const res = await fetch(API_BASE + path, { ...opts, headers });

    if (res.status === 401) {          // token หมดอายุ → เด้งกลับหน้าล็อกอิน
        Token.set(null);
        logout();
        $("authErr").textContent = t("auth.expired");
        throw new Error("UNAUTHORIZED");
    }
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json())?.error?.message || msg; } catch { }
        throw new Error(msg);
    }
    return res;
}

/* ---------- ยิงจริง ---------- */
async function realRequest(cfg, signal) {
    let res;
    if (cfg.type === "text2img") {
        const [w, h] = (optionState.size || "1024x1024").split("x").map(Number);
        res = await apiFetch(cfg.endpoint, {
            method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: $("promptInput").value.trim(),
                negative_prompt: $("negativeInput").value.trim(),
                width: w, height: h, steps: optionState.steps,
            }),
        });
    } else {
        const fd = new FormData();
        fd.append("image", currentFile);
        Object.entries(optionState).forEach(([k, v]) => fd.append(k, String(v)));
        res = await apiFetch(cfg.endpoint, { method: "POST", body: fd, signal });
    }
    return URL.createObjectURL(await res.blob());
}

/* ---------- Mock ---------- */
async function mockRequest(cfg) {
    await new Promise((r) => setTimeout(r, 1200));
    if (cfg.type === "text2img") {
        const [w, h] = (optionState.size || "1024x1024").split("x");
        // ".png" สำคัญมาก — ถ้าไม่ใส่ placehold.co จะส่ง SVG มาให้ (ค่าเริ่มต้นของบริการ)
        return `https://placehold.co/${w}x${h}/1f2937/94a3b8.png?text=MOCK+GenImage`;
    }
    const filters = {
        back: "contrast(1.12) drop-shadow(0 0 1px #000)",
        icon: "saturate(1.06) blur(.3px)",
        tone: {
            warm: "sepia(.4) saturate(1.3)", cool: "hue-rotate(190deg) saturate(1.1)",
            pastel: "saturate(.7) brightness(1.08)", mono: "grayscale(1)",
            vivid: "saturate(1.6) contrast(1.1)", cinematic: "contrast(1.25) sepia(.2)"
        }[optionState.tone],
    };
    $("resultImage").style.filter = $("soloImage").style.filter = filters[currentTab] || "none";
    return previewURL();          // ใช้ URL เดียวกับ thumb — registry กันลบซ้ำให้แล้ว
}

/* ============================================================
   6. ล็อกอิน / บัญชี  (mock — เก็บใน localStorage)
   ============================================================ */
const users = () => JSON.parse(localStorage.getItem(STORE + "users") || "[]");
const saveUsers = (u) => localStorage.setItem(STORE + "users", JSON.stringify(u));

/* ⚠️ djb2 ไม่ใช่ cryptographic hash — ใช้ได้เฉพาะโหมด mock เท่านั้น
   ระบบจริงต้องแฮชที่ "หลังบ้าน" ด้วย argon2id หรือ bcrypt (cost >= 12)
   การแฮชฝั่ง client ไม่ช่วยเรื่องความปลอดภัยเลย เพราะโค้ดเปิดให้อ่านได้ทุกคน */
const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(16); };

function openAuth(mode = "login") {
    authMode = mode;
    $("authTitle").textContent = t(mode === "login" ? "auth.title" : "auth.titleReg");
    $("authSubmit").textContent = t(mode === "login" ? "auth.login" : "auth.register");
    $("authSwitch").textContent = t(mode === "login" ? "auth.toReg" : "auth.toLogin");
    $("nameField").hidden = mode === "login";
    $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("authErr").textContent = "";
    $("authModal").hidden = false;
    $("authClose").hidden = authRequired();
    setTimeout(() => $(mode === "login" ? "authEmail" : "authName").focus(), 50);
}

$("authSwitch").onclick = () => openAuth(authMode === "login" ? "register" : "login");

$("authForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("authName").value.trim();
    const email = $("authEmail").value.trim().toLowerCase();
    const pass = $("authPass").value;
    const err = (k) => ($("authErr").textContent = t(k));

    if (!email || !pass || (authMode === "register" && !name)) return err("auth.errFields");
    if (!/^\S+@\S+\.\S+$/.test(email)) return err("auth.errEmail");

    // ตรวจความแข็งแรงของรหัสผ่าน "เฉพาะตอนสมัคร"
    // ตอนล็อกอินไม่ตรวจ เพราะบัญชีเก่าอาจตั้งไว้ก่อนกฎใหม่ (ระบบจริงก็ทำแบบนี้)
    if (authMode === "register") {
        if (pass.length < 8) return err("auth.errShort");
        if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return err("auth.errWeak");
    }

    const list = users();
    const found = list.find((u) => u.email === email);

    if (authMode === "register") {
        if (found) return err("auth.errExists");
        list.push({ name, email, pw: hash(pass), role: "user", created_at: new Date().toISOString() });
        saveUsers(list);
        login({ name, email, role: "user" });
    } else {
        // ข้อความ error ต้องคลุมเครือเหมือนกันทั้ง 2 กรณี
        // ไม่งั้นคนร้ายจะเดาได้ว่าอีเมลไหนมีอยู่ในระบบ (user enumeration)
        if (!found) return err("auth.errNoUser");
        if (found.pw !== hash(pass)) return err("auth.errPass");
        login({ name: found.name, email: found.email, role: found.role || "user" });
    }
});

function login(u, token = null) {
    const exp = Date.now() + SESSION_TTL_HOURS * 3600 * 1000;
    user = { ...u, exp };
    sessionExpired = false;
    localStorage.setItem(STORE + "session", JSON.stringify(user));
    if (token) Token.set(token);          // โหมดจริง: เก็บ access_token จากหลังบ้าน
    $("authForm").reset();
    clearFile();                          // ไม่ให้ไฟล์ของคนก่อนหน้าค้างข้ามบัญชี
    clearResult();
    loadTabPrefs();
    loadNotes();
    applyI18n();
    refreshAuthState();                   // ปลดล็อกหน้าจอ + ปิดกล่องล็อกอิน
    if (!visibleTabs().includes(currentTab)) switchTab(visibleTabs()[0]);
    showHint(t("auth.welcome", { name: u.name }), true);
}

function logout() {
    user = null;
    localStorage.removeItem(STORE + "session");
    Token.set(null);
    clearFile();
    clearResult();
    loadTabPrefs();                       // กลับไปใช้ค่าของ guest
    loadNotes();
    applyI18n();
    refreshAuthState();                   // ล็อกหน้าจอ + เปิดกล่องล็อกอินค้างไว้
}

/* ============================================================
   7. ตั้งค่า — ภาษา + โน้ต
   ============================================================ */
let noteTimer;
function loadNotes() { $("notesInput").value = localStorage.getItem(uKey("notes")) || ""; }

$("notesInput").addEventListener("input", () => {
    if (authRequired()) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        localStorage.setItem(uKey("notes"), $("notesInput").value);
        $("notesStatus").textContent = `✓ ${t("settings.saved")} · ${new Date().toLocaleTimeString()}`;
    }, 500);
});

$("langSelect").addEventListener("change", (e) => {
    lang = e.target.value;
    localStorage.setItem(STORE + "lang", lang);   // ภาษาเก็บแยกจากบัญชี ใช้ร่วมทุกคน
    applyI18n();
});

$("btnReset").onclick = () => {
    Object.keys(localStorage).filter((k) => k.startsWith(STORE)).forEach((k) => localStorage.removeItem(k));
    user = null; lang = "th";
    Blobs.clearAll();
    clearFile(); clearResult();
    loadTabPrefs(); loadNotes(); applyI18n();
    $("langSelect").value = lang;
    $("settingsModal").hidden = true;
    $("notesStatus").textContent = t("settings.resetOk");
    refreshAuthState();                   // ล้างข้อมูล = ออกจากระบบด้วย
};

/* ============================================================
   8. เมนู / Modal / URL
   ============================================================ */
const openModal = (id) => ($(id).hidden = false);

/** กล่องล็อกอินต้องปิดไม่ได้ ถ้ายังไม่ผ่านการยืนยันตัวตน */
const canClose = (m) => !(m.id === "authModal" && authRequired());

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => {
    const m = b.closest(".modal");
    if (canClose(m)) m.hidden = true;
}));

document.querySelectorAll(".modal").forEach((m) => (m.onclick = (e) => {
    if (e.target === m && canClose(m)) m.hidden = true;
}));

document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".modal").forEach((m) => { if (canClose(m)) m.hidden = true; });
});

$("btnMenu").onclick = (e) => {
    e.stopPropagation();
    if (guardAuth()) return;
    $("menuPop").hidden = !$("menuPop").hidden;
};
$("btnAccount").onclick = (e) => {
    e.stopPropagation();
    user ? ($("menuPop").hidden = !$("menuPop").hidden) : openAuth("login");
};
document.addEventListener("click", () => ($("menuPop").hidden = true));
$("menuPop").onclick = (e) => e.stopPropagation();

$("menuPop").querySelectorAll(".pop-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        $("menuPop").hidden = true;
        const act = btn.dataset.act;
        if (act === "auth") { user ? logout() : openAuth("login"); return; }
        if (guardAuth()) return;                    // settings / tabs ต้องล็อกอินก่อน
        if (act === "settings") { $("langSelect").value = lang; loadNotes(); openModal("settingsModal"); }
        if (act === "tabs") { renderTabManager(); openModal("tabsModal"); }
    });
});

$("btnTabs").onclick = () => {
    if (guardAuth()) return;
    renderTabManager();
    openModal("tabsModal");
};

function syncURL() {
    const cfg = TAB_CONFIG[currentTab];
    const p = new URLSearchParams();
    if (cfg.usesPrompt) {
        const pr = $("promptInput").value.trim(), ng = $("negativeInput").value.trim();
        if (pr) p.set("prompt", pr);
        if (ng) p.set("negativePrompt", ng);
    }
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? "?" + qs : ""}#${currentTab}`);
}

/* ---------- Uploader events ---------- */
const dz = $("dropZone");
if (dz) {
    dz.onclick = () => { if (guardAuth()) return; $("fileInput").click(); };
    dz.onkeydown = (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (guardAuth()) return;
        $("fileInput").click();
    };
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        if (!authRequired()) dz.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
    dz.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
}
$("fileInput").onchange = (e) => setFile(e.target.files[0]);
$("btnClearFile").onclick = () => { if (guardAuth()) return; clearFile(); clearResult(); };
$("clearPrompt").onclick = () => {
    if (guardAuth()) return;
    $("promptInput").value = ""; $("negativeInput").value = ""; syncURL();
};
[$("promptInput"), $("negativeInput")].forEach((el) => el.addEventListener("input", syncURL));

/* ---------- กันการลากไฟล์มาวางนอก dropzone (เบราว์เซอร์จะเปิดไฟล์แทนหน้าเว็บ) ---------- */
["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => { if (e.target !== dz && !dz?.contains(e.target)) e.preventDefault(); })
);

/* ---------- ซิงก์สถานะข้ามแท็บเบราว์เซอร์ ---------- */
window.addEventListener("storage", (e) => {
    if (e.key !== STORE + "session") return;
    user = loadSession();                 // ออกจากระบบที่แท็บหนึ่ง → แท็บอื่นล็อกตาม
    applyI18n();
    refreshAuthState();
});

/* ============================================================
   9. Init
   ============================================================ */
(function init() {
    $("mockBadge").hidden = !USE_MOCK;
    loadTabPrefs();
    loadNotes();

    const q = new URLSearchParams(location.search);
    const hashTab = location.hash.replace("#", "");
    const start = visibleTabs().includes(hashTab) ? hashTab : visibleTabs()[0];

    applyI18n();
    switchTab(start);

    if (TAB_CONFIG[start].usesPrompt) {
        $("promptInput").value = q.get("prompt") || "";
        $("negativeInput").value = q.get("negativePrompt") || "";
    }
    $("langSelect").value = lang;

    refreshAuthState();                                   // ล็อก/ปลดล็อกตามสถานะจริง
    if (sessionExpired) $("authErr").textContent = t("auth.expired");
})();