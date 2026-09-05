/* ============================================================
   script.js — ทั้งหมดของหน้าบ้าน
   ============================================================ */
const $ = (id) => document.getElementById(id);
resultImage
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
/* ---------- State ---------- */
let lang = localStorage.getItem(STORE + "lang") || "th";
let user = JSON.parse(localStorage.getItem(STORE + "session") || "null");
let currentTab = null;
let currentFile = null;
let previewURL = null;
let resultURL = null;
let beforeURL = null;
let optionState = {};
let tabPrefs = null;
let authMode = "login";

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
    $("avatarText").textContent = user ? user.name.slice(0, 1).toUpperCase() : "?";
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
        b.onclick = () => switchTab(id);
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
   2. switchTab + renderOptions
   ============================================================ */
function switchTab(name, keepResult = false) {
    currentTab = name;
    const cfg = TAB_CONFIG[name];

    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

    /* --- Prompt: เฉพาะแท็บที่ใช้จริง --- */
    $("promptGroup").hidden = !cfg.usesPrompt;
    [$("promptInput"), $("negativeInput")].forEach((el) => (el.disabled = !cfg.usesPrompt));
    if (!cfg.usesPrompt) { $("promptInput").value = ""; $("negativeInput").value = ""; }

    /* --- Uploader --- */
    $("uploaderGroup").hidden = !cfg.needsFile;
    if (!cfg.needsFile) clearFile();
    $("dzHint").textContent = L(cfg.hint);

    renderOptions(cfg);
    $("submitBtn").textContent = L(cfg.cta);
    showHint(L(cfg.hint), true);
    if (!keepResult) clearResult();
    syncURL();
}

function renderOptions(cfg, preserve = false) {
    const prev = preserve ? { ...optionState } : {};
    const box = $("optionsGroup");
    box.innerHTML = "";
    optionState = {};

    Object.entries(cfg.fields || {}).forEach(([key, f]) => {
        const start = prev[key] !== undefined ? prev[key] : f.default;   // 👈 คงค่าเดิม
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
    if (!file) return;
    const cfg = TAB_CONFIG[currentTab];
    if (!cfg.accept?.includes(file.type)) return showHint(t("hint.badType"));
    if (file.size > cfg.maxMB * 1024 * 1024) return showHint(t("hint.tooLarge", { n: cfg.maxMB }));

    clearResult();                                   // 👈 #8 ผลลัพธ์เก่าไม่ผูกกับไฟล์ใหม่
    currentFile = file;
    $("thumb").src = Blobs.fromFile("preview", file); // 👈 #1 registry ดูแล revoke ให้เอง
    $("fileName").textContent = file.name;
    $("fileSize").textContent = (file.size / 1048576).toFixed(2) + " MB";
    $("dropZone").hidden = true;
    $("filePreview").hidden = false;
    showHint(L(cfg.hint), true);
}

function clearFile() {
    currentFile = null;
    $("fileInput").value = "";
    $("thumb").removeAttribute("src");   // 👈 #3 ล้าง src ก่อน revoke เสมอ
    Blobs.clear("preview");              //     ถ้า result ยังใช้ URL นี้ → registry จะไม่ revoke
    $("dropZone").hidden = false;
    $("filePreview").hidden = true;
}


/* ============================================================
   4. ผลลัพธ์ / ดาวน์โหลด / เทียบก่อน-หลัง
   ============================================================ */

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
    $("btnDownload").disabled = false;

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
    const url = resultURL();
    if (!url) return;
    const ext = TAB_CONFIG[currentTab].returns === "image/jpeg" ? "jpg" : "png";
    const name = `${currentTab}-${Date.now()}.${ext}`;
    let href = url, temp = null;

    try {
        if (!url.startsWith("blob:")) {                      // remote → ดึงเป็น blob ก่อน
            const blob = await (await fetch(url, { mode: "cors" })).blob();
            href = temp = URL.createObjectURL(blob);
        }
        const a = document.createElement("a");
        a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
    } catch {
        window.open(url, "_blank", "noopener");              // fallback
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
    const cfg = TAB_CONFIG[currentTab];
    if (cfg.usesPrompt && !$("promptInput").value.trim()) {
        showHint(t("hint.needPrompt")); $("promptInput").focus(); return false;
    }
    if (cfg.needsFile && !currentFile) { showHint(t("hint.needFile")); return false; }
    return true;
}

function setBusy(on) {
    $("submitBtn").disabled = on;
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
    setBusy(true);                                  // 👈 เรียกครั้งเดียว หลัง clearResult
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

/* ---------- ยิงจริง ---------- */
async function realRequest(cfg, signal) {
    let res;
    if (cfg.type === "text2img") {
        const [w, h] = (optionState.size || "1024x1024").split("x").map(Number);
        res = await fetch(API_BASE + cfg.endpoint, {
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
        res = await fetch(API_BASE + cfg.endpoint, { method: "POST", body: fd, signal });
    }

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json())?.error?.message || msg; } catch { }
        throw new Error(msg);
    }
    return URL.createObjectURL(await res.blob());
}

/* ---------- Mock ---------- */
async function mockRequest(cfg) {
    await new Promise((r) => setTimeout(r, 1200));
    if (cfg.type === "text2img") {
        const [w, h] = (optionState.size || "1024x1024").split("x");
        return `https://placehold.co/${w}x${h}/1f2937/94a3b8?text=MOCK+GenImage`;
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
    return previewURL();          // 👈 เดิม return previewURL

}
renderOptions
/* ============================================================
   6. ล็อกอิน / บัญชี  (mock — เก็บใน localStorage)
   ============================================================ */
const users = () => JSON.parse(localStorage.getItem(STORE + "users") || "[]");
const saveUsers = (u) => localStorage.setItem(STORE + "users", JSON.stringify(u));
const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(16); };

function openAuth(mode = "login") {
    authMode = mode;
    $("authTitle").textContent = t(mode === "login" ? "auth.title" : "auth.titleReg");
    $("authSubmit").textContent = t(mode === "login" ? "auth.login" : "auth.register");
    $("authSwitch").textContent = t(mode === "login" ? "auth.toReg" : "auth.toLogin");
    $("nameField").hidden = mode === "login";
    $("authErr").textContent = "";
    $("authModal").hidden = false;
    $("authEmail").focus();
}

$("authSwitch").onclick = () => openAuth(authMode === "login" ? "register" : "login");
$("authGuest").onclick = () => { $("authModal").hidden = true; };

$("authForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("authName").value.trim();
    const email = $("authEmail").value.trim().toLowerCase();
    const pass = $("authPass").value;
    const err = (k) => ($("authErr").textContent = t(k));

    if (!email || !pass || (authMode === "register" && !name)) return err("auth.errFields");
    if (!/^\S+@\S+\.\S+$/.test(email)) return err("auth.errEmail");
    if (pass.length < 6) return err("auth.errShort");

    const list = users();
    const found = list.find((u) => u.email === email);

    if (authMode === "register") {
        if (found) return err("auth.errExists");
        list.push({ name, email, pw: hash(pass) });
        saveUsers(list);
        login({ name, email });
    } else {
        if (!found) return err("auth.errNoUser");
        if (found.pw !== hash(pass)) return err("auth.errPass");
        login({ name: found.name, email: found.email });
    }
});

function login(u) {
    user = u;
    localStorage.setItem(STORE + "session", JSON.stringify(u));
    $("authModal").hidden = true;
    $("authForm").reset();
    loadTabPrefs();
    loadNotes();
    applyI18n();
    showHint(t("auth.welcome", { name: u.name }), true);
}

function logout() {
    user = null;
    localStorage.removeItem(STORE + "session");
    loadTabPrefs();
    loadNotes();
    applyI18n();
}

/* ============================================================
   7. ตั้งค่า — ภาษา + โน้ต
   ============================================================ */
let noteTimer;
function loadNotes() { $("notesInput").value = localStorage.getItem(uKey("notes")) || ""; }

$("notesInput").addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        localStorage.setItem(uKey("notes"), $("notesInput").value);
        $("notesStatus").textContent = `✓ ${t("settings.saved")} · ${new Date().toLocaleTimeString()}`;
    }, 500);
});

$("langSelect").addEventListener("change", (e) => {
    lang = e.target.value;
    localStorage.setItem(STORE + "lang", lang);
    applyI18n();
});

$("btnReset").onclick = () => {
    Object.keys(localStorage).filter((k) => k.startsWith(STORE)).forEach((k) => localStorage.removeItem(k));
    user = null; lang = "th";
    loadTabPrefs(); loadNotes(); applyI18n();
    $("notesStatus").textContent = t("settings.resetOk");
};

/* ============================================================
   8. เมนู / Modal / URL
   ============================================================ */
const openModal = (id) => ($(id).hidden = false);
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));
document.querySelectorAll(".modal").forEach((m) =>
    (m.onclick = (e) => { if (e.target === m) m.hidden = true; }));
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
});

$("btnMenu").onclick = (e) => { e.stopPropagation(); $("menuPop").hidden = !$("menuPop").hidden; };
$("btnAccount").onclick = (e) => { e.stopPropagation(); user ? ($("menuPop").hidden = !$("menuPop").hidden) : openAuth("login"); };
document.addEventListener("click", () => ($("menuPop").hidden = true));
$("menuPop").onclick = (e) => e.stopPropagation();

$("menuPop").querySelectorAll(".pop-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        $("menuPop").hidden = true;
        const act = btn.dataset.act;
        if (act === "settings") { $("langSelect").value = lang; loadNotes(); openModal("settingsModal"); }
        if (act === "tabs") { renderTabManager(); openModal("tabsModal"); }
        if (act === "auth") user ? logout() : openAuth("login");
    });
});

$("btnTabs").onclick = () => { renderTabManager(); openModal("tabsModal"); };

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
    dz.onclick = () => $("fileInput").click();
    dz.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } };
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
    dz.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
}
$("fileInput").onchange = (e) => setFile(e.target.files[0]);
$("clearFile").onclick = () => { clearFile(); clearResult(); };
$("clearPrompt").onclick = () => { $("promptInput").value = ""; $("negativeInput").value = ""; syncURL(); };
[$("promptInput"), $("negativeInput")].forEach((el) => el.addEventListener("input", syncURL));

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
})();

__blobs()
// ก่อนแก้ → {preview:'blob:...', result:'blob:...', ...} สะสมเรื่อย ๆ ใน Memory tab
// หลังแก้ → {} ว่างเปล่าทุกครั้งหลัง Remove
