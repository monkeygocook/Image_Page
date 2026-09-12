/* ============================================================
   admin.js — หน้าเจ้าหน้าที่ (Staff Console)
   อัปเดต: 2026-09-11 (ทุกการอ่าน/เขียนผ่าน Api.admin.*)

   ⚠️ ไฟล์นี้ห้ามเรียก fetch() หรือแตะ localStorage ของข้อมูลธุรกิจโดยตรง
   ============================================================ */
const $ = (id) => document.getElementById(id);

let lang = localStorage.getItem(STORE + "lang") || "th";
let me = Api.Session.load();
let cache = [];              // รายชื่อผู้ใช้ล่าสุดที่ดึงมา (กรองในเครื่อง ไม่ยิงซ้ำ)
let loading = false;

/* ---------- i18n ---------- */
const t = (k, vars = {}) =>
    (I18N[lang][k] || k).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? "");

function errMsg(err) {
    if (!err) return t("err.UNKNOWN");
    const key = "err." + (err.code || "UNKNOWN");
    let msg = I18N[lang][key] || err.message || t("err.UNKNOWN");
    if (err.requestId) msg += t("hint.reqId", { id: err.requestId });
    return msg;
}

function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $("mockBadge").textContent = t("badge.mock");
    if (me && me.role !== "staff") {
        $("deniedDesc").textContent = t("admin.deniedDesc", { role: t("role." + (me.role || "user")) });
    }
    updateConn();
    if (isStaff()) paint();
}

/* ---------- ป้ายสถานะการเชื่อมต่อ ---------- */
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
Api.onUnauthorized(() => location.replace(APP_PAGE));

$("connBadge").onclick = async () => { await Api.ping(); updateConn(); };

/* ---------- ตัวช่วย ---------- */
const isStaff = () => !!me && me.role === "staff";
const staffCount = () => cache.filter((u) => u.role === "staff").length;

let msgTimer;
function showMsg(text, isError = false) {
    const el = $("adminMsg");
    el.textContent = text;
    el.classList.toggle("err", isError);
    el.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (el.hidden = true), 5000);
}

function storageKB() {
    let bytes = 0;
    Object.keys(localStorage).forEach((k) => {
        if (k.startsWith(STORE)) bytes += k.length + (localStorage.getItem(k) || "").length;
    });
    return (bytes / 1024).toFixed(1);
}

function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(lang === "th" ? "th-TH" : "en-US", {
        year: "numeric", month: "short", day: "numeric",
    });
}

/* ============================================================
   ชั้นที่ 3 — ตรวจสิทธิ์ซ้ำก่อนทุกการกระทำ
   ============================================================ */
function guardStaff() {
    me = Api.Session.load();                  // อ่านใหม่ทุกครั้ง เผื่อถูก logout จากแท็บอื่น
    if (isStaff()) return false;
    location.replace(APP_PAGE);
    return true;
}

async function changeRole(key, newRole) {
    if (guardStaff()) return;
    try {
        await Api.admin.setRole(key, newRole);
        showMsg(t("admin.msgRole", { email: key, role: t("role." + newRole) }));
        await reload();
    } catch (err) {
        showMsg(errMsg(err), true);
    }
}

async function removeUser(key) {
    if (guardStaff()) return;
    if (!confirm(t("admin.confirmDelete", { email: key }))) return;
    try {
        await Api.admin.remove(key);
        showMsg(t("admin.msgDeleted", { email: key }));
        await reload();
    } catch (err) {
        showMsg(errMsg(err), true);
    }
}

/* ============================================================
   วาดตาราง — ใช้ textContent ทุกจุดที่เป็นข้อมูลผู้ใช้
   (ห้ามใช้ innerHTML กับชื่อ/อีเมล มิฉะนั้นเปิดช่อง Stored XSS)
   ============================================================ */
function makeCell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
}

function buildRow(u) {
    const key = Api.admin.keyOf(u);
    const tr = document.createElement("tr");
    const isMe = u.email === me.email;
    const targetIsStaff = u.role === "staff";
    const lastStaff = targetIsStaff && staffCount() <= 1;

    const tdName = document.createElement("td");
    tdName.textContent = u.name || "—";
    if (isMe) {
        const tag = document.createElement("span");
        tag.className = "you-tag";
        tag.textContent = t("admin.you");
        tdName.appendChild(tag);
    }
    tr.appendChild(tdName);

    tr.appendChild(makeCell(u.email, "mono-cell"));

    const tdRole = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "role-tag" + (targetIsStaff ? " staff" : "");
    badge.textContent = t("role." + (u.role || "user"));
    tdRole.appendChild(badge);
    tr.appendChild(tdRole);

    tr.appendChild(makeCell(fmtDate(u.created_at)));

    const tdAct = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const btnRole = document.createElement("button");
    btnRole.type = "button";
    btnRole.className = "btn-sm";
    btnRole.textContent = targetIsStaff ? t("admin.demote") : t("admin.promote");
    btnRole.disabled = isMe || lastStaff || loading;
    btnRole.onclick = () => changeRole(key, targetIsStaff ? "user" : "staff");

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-sm danger";
    btnDel.textContent = t("admin.delete");
    btnDel.disabled = isMe || lastStaff || loading;
    btnDel.onclick = () => removeUser(key);

    wrap.append(btnRole, btnDel);
    tdAct.appendChild(wrap);
    tr.appendChild(tdAct);

    return tr;
}

/** วาดจาก cache อย่างเดียว ไม่ยิง API — ใช้ตอนพิมพ์ค้นหา/เปลี่ยนภาษา */
function paint() {
    if (!isStaff()) return;

    const q = $("searchInput").value.trim().toLowerCase();
    const filtered = q
        ? cache.filter((u) =>
            (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q))
        : cache;

    $("statTotal").textContent = cache.length;
    $("statStaff").textContent = cache.filter((u) => u.role === "staff").length;
    $("statUser").textContent = cache.filter((u) => u.role !== "staff").length;
    $("statSize").textContent = storageKB() + " KB";
    $("whoami").textContent = `${me.name} (${me.email})`;

    const tbody = $("userRows");
    tbody.innerHTML = "";
    filtered.forEach((u) => tbody.appendChild(buildRow(u)));
    $("emptyRow").hidden = filtered.length > 0;
}

/** ดึงข้อมูลใหม่จาก Api แล้ววาด */
async function reload() {
    if (guardStaff()) return;
    loading = true;
    $("btnRefresh").disabled = true;
    try {
        cache = await Api.admin.list();
    } catch (err) {
        showMsg(errMsg(err), true);
        cache = [];
    } finally {
        loading = false;
        $("btnRefresh").disabled = false;
        paint();
    }
}

/* ============================================================
   Events
   ============================================================ */
$("searchInput").addEventListener("input", paint);
$("btnRefresh").onclick = reload;

$("langSelect").addEventListener("change", (e) => {
    lang = e.target.value;
    localStorage.setItem(STORE + "lang", lang);
    applyI18n();
});

$("btnLogout").onclick = async () => {
    try { await Api.auth.logout(); } catch { }
    location.replace(APP_PAGE);
};

$("btnExport").onclick = () => {
    if (guardStaff()) return;
    // ตัด pw (hash) ออกก่อนส่งออกเสมอ — ข้อมูลรับรองตัวตนห้ามหลุดออกจากระบบ
    const data = cache.map(({ pw, ...safe }) => safe);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showMsg(t("admin.msgExport"));
};

/* ---------- ซิงก์ข้ามแท็บ ---------- */
window.addEventListener("storage", (e) => {
    if (e.key !== STORE + "session" && e.key !== STORE + "users") return;
    me = Api.Session.load();
    if (!isStaff()) { location.replace(APP_PAGE); return; }
    reload();
});

/* ============================================================
   Boot — ชั้นที่ 1 และ 2
   ============================================================ */
(async function boot() {
    $("langSelect").value = lang;
    updateConn();

    // ชั้นที่ 1: ยังไม่ล็อกอิน → กลับหน้าหลักทันที (replace = กด Back ย้อนกลับไม่ได้)
    if (!me) { location.replace(APP_PAGE); return; }

    await Api.init();
    $("mockBadge").hidden = !Api.isMock();

    // โหมด live: ยืนยัน role กับเซิร์ฟเวอร์อีกครั้ง ไม่เชื่อค่าใน localStorage
    if (Api.isLive()) {
        try {
            const j = await Api.auth.me();
            if (j?.user) me = Api.Session.save(j.user, null);
        } catch {
            location.replace(APP_PAGE);
            return;
        }
    }

    // ชั้นที่ 2: ล็อกอินแล้วแต่ไม่ใช่เจ้าหน้าที่ → แสดงหน้าปฏิเสธ
    const staff = isStaff();
    $("adminView").hidden = !staff;
    $("deniedView").hidden = staff;

    applyI18n();
    if (staff) await reload();
})();