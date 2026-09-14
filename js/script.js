/* ============================================================
   script.js — ส่วนติดต่อผู้ใช้ของหน้าหลัก
   อัปเดต: 2026-09-11 (ย้ายทุกการเชื่อมต่อไป api.js + ปุ่มยกเลิก + ป้ายสถานะ)

   ⚠️ ไฟล์นี้ห้ามเรียก fetch() หรือแตะ localStorage ของข้อมูลธุรกิจโดยตรง
      ทุกอย่างต้องผ่าน Api.*
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
window.__api = () => ({ mode: Api.mode(), online: Api.isOnline(), base: Api.base(), reqId: Api.lastRequestId() });

/* ============================================================
   State
   ============================================================ */
let lang = localStorage.getItem(STORE + "lang") || "th";
let user = Api.Session.load();
let currentTab = null;
let currentFile = null;
let optionState = {};
let tabPrefs = null;
let authMode = "login";
let inflight = null;            // AbortController ของงานที่กำลังทำอยู่

const previewURL = () => Blobs.get("preview");
const resultURL = () => Blobs.get("result");
const beforeURL = () => Blobs.get("before");

/* ---------- ด่านตรวจสิทธิ์ ---------- */
const authRequired = () => REQUIRE_AUTH && !user;
const isStaff = () => !!user && user.role === "staff";

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

/** แปลง ApiError เป็นข้อความที่ผู้ใช้อ่านรู้เรื่อง */
function errMsg(err) {
    if (!err) return t("err.UNKNOWN");
    const key = "err." + (err.code || "UNKNOWN");
    let msg = I18N[lang][key] || err.message || t("err.UNKNOWN");
    if (err.code === "RATE_LIMITED" && err.retryAfter) msg += ` (${err.retryAfter}s)`;
    if (err.requestId) msg += t("hint.reqId", { id: err.requestId });
    return msg;
}

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
    $("popRole").classList.toggle("staff", isStaff());
    $("popAdmin").hidden = !isStaff();
    $("avatarText").textContent = user ? user.name.slice(0, 1).toUpperCase() : "?";
    if (!$("authModal").hidden) openAuth(authMode);
    updateConn();
    renderTabBar();
    if (currentTab) switchTab(currentTab, true);
}

/* ============================================================
   0.5 ป้ายสถานะการเชื่อมต่อ
   ============================================================ */
function updateConn() {
    const el = $("connBadge");
    if (!el) return;
    const mock = Api.isMock();
    const ok = Api.isOnline();
    el.classList.toggle("mock", mock);
    el.classList.toggle("ok", !mock && ok);
    el.classList.toggle("down", !mock && !ok);
    el.classList.toggle("checking", !Api.isReady());
    $("connText").textContent = !Api.isReady()
        ? t("conn.checking")
        : mock ? t("conn.mock") : (ok ? t("conn.online") : t("conn.offline"));
    el.title = `${t("conn.tip")}\n${Api.base()}`;
}

Api.onStatus(updateConn);
Api.onUnauthorized(() => {                 // token หมดอายุระหว่างใช้งาน
    user = null;
    applyI18n();
    refreshAuthState();
    $("authErr").textContent = t("auth.expired");
});

$("connBadge").onclick = async () => {
    $("connBadge").classList.add("checking");
    $("connText").textContent = t("conn.checking");
    await Api.ping();
    updateConn();
};

/* ============================================================
   1. Tab bar + ตัวจัดการแท็บ (ดินสอ)
   ============================================================ */
const uTabKey = () => `${STORE}${user ? user.email : "guest"}:tabs`;

function loadTabPrefs() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(uTabKey()) || "null"); } catch { }
    const valid = saved?.filter((x) => TAB_CONFIG[x.id]);
    tabPrefs = valid?.length ? valid : TAB_ORDER.map((id) => ({ id, on: true }));

    // เผื่อเพิ่มแท็บใหม่ในอนาคต — ผู้ใช้เก่าจะได้แท็บใหม่ต่อท้ายอัตโนมัติ
    let added = false;
    TAB_ORDER.forEach((id) => {
        if (!tabPrefs.some((x) => x.id === id)) { tabPrefs.push({ id, on: true }); added = true; }
    });
    if (added) saveTabPrefs();
}

function saveTabPrefs() {
    localStorage.setItem(uTabKey(), JSON.stringify(tabPrefs));   // เขียนในเครื่องก่อน (ตอบสนองทันที)
    if (Api.isLive()) Api.user.savePreferences({ lang, tabs: tabPrefs }).catch(() => { });
}

const visibleTabs = () => tabPrefs.filter((x) => x.on).map((x) => x.id);

/** ดึงการตั้งค่าจากเซิร์ฟเวอร์มาทับของในเครื่อง (โหมด live เท่านั้น) */
async function pullPrefs() {
    if (!Api.isLive() || !user) return;
    try {
        const p = await Api.user.getPreferences();
        if (p.lang && p.lang !== lang) { lang = p.lang; $("langSelect").value = lang; }
        if (Array.isArray(p.tabs) && p.tabs.length) {
            tabPrefs = p.tabs.filter((x) => TAB_CONFIG[x.id]);
            TAB_ORDER.forEach((id) => {
                if (!tabPrefs.some((x) => x.id === id)) tabPrefs.push({ id, on: true });
            });
        }
        applyI18n();
    } catch { /* ดึงไม่ได้ก็ใช้ของในเครื่องต่อไป */ }
}

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
        chk.onchange = () => { item.on = chk.checked; commitTabs(); };
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
function applyLockState() {
    const locked = authRequired();
    const cfg = currentTab ? TAB_CONFIG[currentTab] : null;

    document.body.classList.toggle("locked", locked);

    [$("promptInput"), $("negativeInput")].forEach(
        (el) => (el.disabled = locked || !cfg?.usesPrompt)
    );
    $("clearPrompt").disabled = locked;
    $("fileInput").disabled = locked;
    $("btnClearFile").disabled = locked;
    $("submitBtn").disabled = locked || !!inflight;
    $("btnDownload").disabled = locked || !resultURL();
    $("dropZone").setAttribute("aria-disabled", String(locked));
    $("authClose").hidden = locked;   // ล็อกอยู่ = ห้ามปิดกล่องล็อกอิน
}

function refreshAuthState() {
    applyLockState();
    if (authRequired()) openAuth("login");
    else $("authModal").hidden = true;
}

function switchTab(name, keepResult = false) {
    currentTab = name;
    const cfg = TAB_CONFIG[name];

    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

    $("promptGroup").hidden = !cfg.usesPrompt;
    if (!cfg.usesPrompt) { $("promptInput").value = ""; $("negativeInput").value = ""; }

    $("uploaderGroup").hidden = !cfg.needsFile;
    if (!cfg.needsFile) clearFile();
    $("dzHint").textContent = L(cfg.hint);

    renderOptions(cfg, keepResult);
    $("submitBtn").textContent = L(cfg.cta);
    showHint(authRequired() ? t("auth.required") : L(cfg.hint), !authRequired());
    if (!keepResult) clearResult();
    applyLockState();
    syncURL();
}

function renderOptions(cfg, preserve = false) {
    const prev = preserve ? { ...optionState } : {};
    const box = $("optionsGroup");
    box.innerHTML = "";
    optionState = {};

    Object.entries(cfg.fields || {}).forEach(([key, f]) => {
        const start = prev[key] !== undefined ? prev[key] : f.default;
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
    if (guardAuth()) return;
    if (!file) return;
    const cfg = TAB_CONFIG[currentTab];
    if (!cfg.accept?.includes(file.type)) return showHint(t("hint.badType"));
    if (file.size > cfg.maxMB * 1024 * 1024) return showHint(t("hint.tooLarge", { n: cfg.maxMB }));

    clearResult();
    currentFile = file;
    $("thumb").src = Blobs.fromFile("preview", file);
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
    Blobs.clear("preview");
    $("dropZone").hidden = false;
    $("filePreview").hidden = true;
}

/* ============================================================
   4. ผลลัพธ์ / ดาวน์โหลด / เทียบก่อน-หลัง
   ============================================================ */
const MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
    "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "image/svg+xml": "svg", "image/bmp": "bmp",
};

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

    const fallbackExt = extFromMime(TAB_CONFIG[currentTab].returns, "png");
    let href = url, temp = null, ext = fallbackExt;

    try {
        // ดึงเป็น blob เสมอ เพื่ออ่าน MIME ของจริง ไม่ใช่ของที่คาดหวัง
        const res = await fetch(url, url.startsWith("blob:") ? {} : { mode: "cors" });
        const blob = await res.blob();
        ext = extFromMime(blob.type, fallbackExt);
        href = temp = URL.createObjectURL(blob);
    } catch { /* CORS บล็อก → ใช้ URL เดิม + นามสกุลตามสัญญา */ }

    const name = `${currentTab}-${Date.now()}.${ext}`;
    try {
        const a = document.createElement("a");
        a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
    } catch {
        window.open(url, "_blank", "noopener");
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
    if (guardAuth()) return false;
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
    $("btnCancel").hidden = !on;
    if (on) { $("resultEmpty").hidden = true; $("soloImage").hidden = true; $("compareWrap").hidden = true; }
}

$("btnCancel").onclick = () => inflight?.abort();

$("genForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;
    if (inflight) return;                       // กันกดซ้ำระหว่างประมวลผล

    const cfg = TAB_CONFIG[currentTab];
    inflight = new AbortController();

    clearResult();
    setBusy(true);
    try {
        const url = await Api.image.process({
            tab: currentTab,
            cfg,
            file: currentFile,
            prompt: $("promptInput").value.trim(),
            negative: $("negativeInput").value.trim(),
            options: optionState,
            previewUrl: previewURL(),
            signal: inflight.signal,
        });
        showResult(url, cfg.needsFile ? previewURL() : null);
        showHint(Api.isMock() ? t("hint.mock") : "", true);
    } catch (err) {
        showHint(err?.name === "AbortError" ? t("hint.abort") : t("hint.error", { msg: errMsg(err) }));
        $("resultEmpty").hidden = false;
    } finally {
        inflight = null;
        setBusy(false);
    }
});

/* ============================================================
   6. ล็อกอิน / บัญชี
   ============================================================ */
function openAuth(mode = "login") {
    authMode = mode;
    $("authTitle").textContent = t(mode === "login" ? "auth.title" : "auth.titleReg");
    $("authSubmit").textContent = t(mode === "login" ? "auth.login" : "auth.register");
    $("authSwitch").textContent = t(mode === "login" ? "auth.toReg" : "auth.toLogin");
    $("nameField").hidden = mode === "login";
    $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("seedNote").textContent = t("auth.seedNote", { email: SEED_STAFF.email, pass: SEED_STAFF.password });
    $("seedNote").hidden = !Api.isMock() || mode !== "login";
    $("authErr").textContent = "";
    $("authModal").hidden = false;
    $("authClose").hidden = authRequired();
    setTimeout(() => $(mode === "login" ? "authEmail" : "authName").focus(), 50);
}

$("authSwitch").onclick = () => openAuth(authMode === "login" ? "register" : "login");

function setAuthBusy(on) {
    $("authSubmit").disabled = on;
    $("authSubmit").textContent = on
        ? t("auth.working")
        : t(authMode === "login" ? "auth.login" : "auth.register");
}

$("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("authName").value.trim();
    const email = $("authEmail").value.trim().toLowerCase();
    const pass = $("authPass").value;
    const err = (k) => ($("authErr").textContent = t(k));

    if (!email || !pass || (authMode === "register" && !name)) return err("auth.errFields");
    if (!/^\S+@\S+\.\S+$/.test(email)) return err("auth.errEmail");

    // ตรวจความแข็งแรงเฉพาะตอนสมัคร — บัญชีเก่าอาจตั้งไว้ก่อนกฎใหม่
    if (authMode === "register") {
        if (pass.length < 8) return err("auth.errShort");
        if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return err("auth.errWeak");
    }

    $("authErr").textContent = "";
    setAuthBusy(true);
    try {
        const res = authMode === "register"
            ? await Api.auth.register({ name, email, password: pass })
            : await Api.auth.login({ email, password: pass });
        await applyLogin(res.user, res.access_token);
    } catch (e2) {
        $("authErr").textContent = errMsg(e2);
    } finally {
        setAuthBusy(false);
    }
});

async function applyLogin(u, token) {
    user = Api.Session.save(u, token);
    $("authForm").reset();
    clearFile();                          // ไม่ให้ไฟล์ของคนก่อนหน้าค้างข้ามบัญชี
    clearResult();
    loadTabPrefs();
    applyI18n();
    refreshAuthState();
    if (!visibleTabs().includes(currentTab)) switchTab(visibleTabs()[0]);
    showHint(t("auth.welcome", { name: u.name }), true);
    loadNotes();
    pullPrefs();
}

async function doLogout() {
    try { await Api.auth.logout(); } catch { }
    user = null;
    inflight?.abort();
    clearFile();
    clearResult();
    loadTabPrefs();
    applyI18n();
    refreshAuthState();
    loadNotes();
}

/* ============================================================
   7. ตั้งค่า — ภาษา + โน้ต
   ============================================================ */
let noteTimer;

async function loadNotes() {
    try { $("notesInput").value = await Api.user.getNotes(); }
    catch { $("notesInput").value = ""; }
}

$("notesInput").addEventListener("input", () => {
    if (authRequired()) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
        const val = $("notesInput").value;
        try {
            await Api.user.saveNotes(val);
            $("notesStatus").textContent = `✓ ${t("settings.saved")} · ${new Date().toLocaleTimeString()}`;
        } catch {
            $("notesStatus").textContent = `⚠ ${t("settings.syncFail")}`;
        }
    }, 500);
});

$("langSelect").addEventListener("change", (e) => {
    lang = e.target.value;
    localStorage.setItem(STORE + "lang", lang);
    if (Api.isLive() && user) Api.user.savePreferences({ lang, tabs: tabPrefs }).catch(() => { });
    applyI18n();
});

$("btnReset").onclick = async () => {
    Api.wipeLocal();
    user = null; lang = "th";
    Blobs.clearAll();
    clearFile(); clearResult();
    loadTabPrefs();
    applyI18n();
    $("langSelect").value = lang;
    $("settingsModal").hidden = true;
    $("notesStatus").textContent = t("settings.resetOk");
    refreshAuthState();
    loadNotes();
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
        if (act === "auth") { user ? doLogout() : openAuth("login"); return; }
        if (guardAuth()) return;
        if (act === "settings") { $("langSelect").value = lang; loadNotes(); openModal("settingsModal"); }
        if (act === "tabs") { renderTabManager(); openModal("tabsModal"); }
        if (act === "admin") {
            if (!isStaff()) return;                 // ตรวจสิทธิ์ซ้ำก่อนพาไปหน้าเจ้าหน้าที่
            location.href = ADMIN_PAGE;
        }
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

/* ---------- กันการลากไฟล์มาวางนอก dropzone ---------- */
["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => { if (e.target !== dz && !dz?.contains(e.target)) e.preventDefault(); })
);

/* ---------- ซิงก์สถานะข้ามแท็บเบราว์เซอร์ ---------- */
window.addEventListener("storage", (e) => {
    if (e.key !== STORE + "session" && e.key !== STORE + "users") return;
    user = Api.Session.load();
    applyI18n();
    refreshAuthState();
});

/* ============================================================
   9. Boot
   ============================================================ */
(async function boot() {
    updateConn();
    await Api.init();                              // ตัดสินใจโหมด mock/live ที่นี่
    $("mockBadge").hidden = !Api.isMock();

    /* โหมด live: ถ้ามี token ค้างอยู่ ต้องถามเซิร์ฟเวอร์ว่ายังใช้ได้ไหม */
    if (Api.isLive() && user && Api.Token.get()) {
        try {
            const j = await Api.auth.me();
            if (j?.user) user = Api.Session.save(j.user, null);
        } catch {
            user = null;                           // token เสีย → ถือว่ายังไม่ล็อกอิน
        }
    }

    loadTabPrefs();

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

    refreshAuthState();
    if (Api.Session.wasExpired()) {
        $("authErr").textContent = t("auth.expired");
        Api.Session.ackExpired();
    }

    loadNotes();
    pullPrefs();
})();
// ใน genForm submit → ไม่ต้องส่ง options สำหรับ tab generate
const url = await Api.image.process({
    tab: currentTab,
    cfg,
    file: currentFile,
    prompt: $("promptInput").value.trim(),
    negative: $("negativeInput").value.trim(),
    options: currentTab === "generate" ? {} : optionState,
    previewUrl: previewURL(),
    signal: inflight.signal,
});