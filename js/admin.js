/* ============================================================
   admin.js — หน้าเจ้าหน้าที่ (Staff Console)
   โหลดคู่กับ config.js เท่านั้น ไม่เกี่ยวกับ script.js
   ============================================================ */
const $ = (id) => document.getElementById(id);

/* ---------- อ่าน session พร้อมตรวจวันหมดอายุ (เหมือนหน้าหลัก) ---------- */
function loadSession() {
    const raw = JSON.parse(localStorage.getItem(STORE + "session") || "null");
    if (!raw) return null;
    if (typeof raw.exp === "number" && Date.now() > raw.exp) {
        localStorage.removeItem(STORE + "session");
        localStorage.removeItem(STORE + "token");
        return null;
    }
    return raw;
}

let lang = localStorage.getItem(STORE + "lang") || "th";
let me = loadSession();

/* ---------- i18n ---------- */
const t = (k, vars = {}) =>
    (I18N[lang][k] || k).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? "");

function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $("mockBadge").textContent = t("badge.mock");
    if (me && me.role !== "staff") {
        $("deniedDesc").textContent = t("admin.deniedDesc", { role: t("role." + (me.role || "user")) });
    }
    if (isStaff()) render();
}

/* ---------- ตัวช่วยเข้าถึงข้อมูลผู้ใช้ ---------- */
const users = () => JSON.parse(localStorage.getItem(STORE + "users") || "[]");
const saveUsers = (u) => localStorage.setItem(STORE + "users", JSON.stringify(u));
const isStaff = () => !!me && me.role === "staff";
const staffCount = () => users().filter((u) => u.role === "staff").length;

/* ---------- แจ้งเตือนบนหน้า ---------- */
let msgTimer;
function showMsg(text, isError = false) {
    const el = $("adminMsg");
    el.textContent = text;
    el.classList.toggle("err", isError);
    el.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- คำนวณพื้นที่ localStorage ที่โปรเจกต์นี้ใช้ ---------- */
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
    me = loadSession();                       // อ่านใหม่ทุกครั้ง เผื่อถูก logout จากแท็บอื่น
    if (isStaff()) return false;
    location.replace(APP_PAGE);
    return true;
}

function changeRole(email, newRole) {
    if (guardStaff()) return;
    if (email === me.email) return showMsg(t("admin.errSelf"), true);

    const list = users();
    const target = list.find((u) => u.email === email);
    if (!target) return;

    // กันระบบเหลือเจ้าหน้าที่ 0 คน
    if (target.role === "staff" && newRole !== "staff" && staffCount() <= 1) {
        return showMsg(t("admin.errLastStaff"), true);
    }

    target.role = newRole;
    saveUsers(list);
    render();
    showMsg(t("admin.msgRole", { email, role: t("role." + newRole) }));
}

function removeUser(email) {
    if (guardStaff()) return;
    if (email === me.email) return showMsg(t("admin.errSelf"), true);

    const list = users();
    const target = list.find((u) => u.email === email);
    if (!target) return;

    if (target.role === "staff" && staffCount() <= 1) {
        return showMsg(t("admin.errLastStaff"), true);
    }
    if (!confirm(t("admin.confirmDelete", { email }))) return;

    saveUsers(list.filter((u) => u.email !== email));
    // ลบข้อมูลส่วนตัวที่ผูกกับอีเมลนี้ด้วย
    [`${STORE}${email}:notes`, `${STORE}${email}:tabs`].forEach((k) => localStorage.removeItem(k));

    render();
    showMsg(t("admin.msgDeleted", { email }));
}

/* ============================================================
   วาดตาราง — ใช้ textContent ทุกจุดที่เป็นข้อมูลผู้ใช้
   (ห้ามใช้ innerHTML กับชื่อ/อีเมล มิฉะนั้นเปิดช่อง XSS)
   ============================================================ */
function makeCell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
}

function buildRow(u) {
    const tr = document.createElement("tr");
    const isMe = u.email === me.email;
    const isTargetStaff = u.role === "staff";
    const lastStaff = isTargetStaff && staffCount() <= 1;

    /* ชื่อ + ป้าย "คุณ" */
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

    /* สิทธิ์ */
    const tdRole = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "role-tag" + (isTargetStaff ? " staff" : "");
    badge.textContent = t("role." + (u.role || "user"));
    tdRole.appendChild(badge);
    tr.appendChild(tdRole);

    tr.appendChild(makeCell(fmtDate(u.created_at)));

    /* ปุ่มจัดการ */
    const tdAct = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const btnRole = document.createElement("button");
    btnRole.type = "button";
    btnRole.className = "btn-sm";
    btnRole.textContent = isTargetStaff ? t("admin.demote") : t("admin.promote");
    btnRole.disabled = isMe || lastStaff;
    btnRole.onclick = () => changeRole(u.email, isTargetStaff ? "user" : "staff");

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-sm danger";
    btnDel.textContent = t("admin.delete");
    btnDel.disabled = isMe || lastStaff;
    btnDel.onclick = () => removeUser(u.email);

    wrap.append(btnRole, btnDel);
    tdAct.appendChild(wrap);
    tr.appendChild(tdAct);

    return tr;
}

function render() {
    if (!isStaff()) return;

    const list = users();
    const q = $("searchInput").value.trim().toLowerCase();
    const filtered = q
        ? list.filter((u) =>
            (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q))
        : list;

    $("statTotal").textContent = list.length;
    $("statStaff").textContent = list.filter((u) => u.role === "staff").length;
    $("statUser").textContent = list.filter((u) => u.role !== "staff").length;
    $("statSize").textContent = storageKB() + " KB";
    $("whoami").textContent = `${me.name} (${me.email})`;

    const tbody = $("userRows");
    tbody.innerHTML = "";
    filtered.forEach((u) => tbody.appendChild(buildRow(u)));
    $("emptyRow").hidden = filtered.length > 0;
}

/* ============================================================
   Events
   ============================================================ */
$("searchInput").addEventListener("input", render);

$("langSelect").addEventListener("change", (e) => {
    lang = e.target.value;
    localStorage.setItem(STORE + "lang", lang);
    applyI18n();
});

$("btnLogout").onclick = () => {
    localStorage.removeItem(STORE + "session");
    localStorage.removeItem(STORE + "token");
    location.replace(APP_PAGE);
};

$("btnExport").onclick = () => {
    if (guardStaff()) return;
    // ตัด pw (hash) ออกก่อนส่งออกเสมอ — ข้อมูลรับรองตัวตนห้ามหลุดออกจากระบบ
    const data = users().map(({ pw, ...safe }) => safe);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showMsg(t("admin.msgExport"));
};

/* ---------- ซิงก์ข้ามแท็บ: ออกจากระบบที่แท็บอื่น → เด้งออกจากหน้านี้ด้วย ---------- */
window.addEventListener("storage", (e) => {
    if (e.key !== STORE + "session" && e.key !== STORE + "users") return;
    me = loadSession();
    if (!isStaff()) { location.replace(APP_PAGE); return; }
    render();
});

/* ============================================================
   Boot — ชั้นที่ 1 และ 2
   ============================================================ */
(function boot() {
    $("mockBadge").hidden = !USE_MOCK;
    $("langSelect").value = lang;

    // ชั้นที่ 1: ยังไม่ล็อกอิน → กลับหน้าหลักทันที (replace = กด Back ย้อนกลับมาไม่ได้)
    if (!me) { location.replace(APP_PAGE); return; }

    // ชั้นที่ 2: ล็อกอินแล้วแต่ไม่ใช่เจ้าหน้าที่ → แสดงหน้าปฏิเสธ
    const staff = isStaff();
    $("adminView").hidden = !staff;
    $("deniedView").hidden = staff;

    applyI18n();
})();