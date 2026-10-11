/* =============================================================
   Staff Console — ทำงานได้ด้วยตัวเอง ไม่พึ่งไฟล์ฝั่งผู้ใช้
   เรียก API แบบ same-origin: /api/... -> nginx ส่งต่อไป :5050
   ============================================================= */

const TOKEN_KEY = "staff_token";
const $ = (id) => document.getElementById(id);
let me = null;

/* ---------- เก็บ token ใน sessionStorage: ปิดแท็บแล้วหลุดเอง ---------- */
const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";
const setToken = (t) =>
    t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

/* ---------- ตัวเรียก API ตัวเดียวของทั้งหน้า ---------- */
async function call(path, { method = "GET", body } = {}) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (getToken()) headers["Authorization"] = "Bearer " + getToken();

    const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // รองรับทั้ง err() ของเรา และ HTTPException ของ FastAPI
        throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
    }
    return data;
}

/* ---------- แสดงข้อความแจ้งผล ---------- */
function say(text, ok = false) {
    const el = $("msg");
    el.textContent = text;
    el.className = "msg" + (ok ? " ok" : "");
    el.hidden = !text;
}

/* ---------- สลับหน้าจอ ---------- */
function render() {
    const signedIn = !!me;
    $("viewLogin").hidden = signedIn;
    $("viewConsole").hidden = !signedIn;
    $("btnLogout").hidden = !signedIn;
    $("whoami").textContent = signedIn ? `${me.name} (${me.email})` : "";
}

/* ---------- กัน XSS: แปลงอักขระพิเศษก่อนใส่ลง HTML ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "-" : d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
};

/* ---------- โหลดรายชื่อผู้ใช้ ---------- */
async function loadUsers() {
    try {
        const { users } = await call("/api/v1/admin/users");
        $("userCount").textContent = users.length;
        $("emptyRow").hidden = users.length > 0;

        $("userRows").innerHTML = users.map((u) => `
            <tr data-key="${esc(u.email)}">
                <td>${esc(u.name)}</td>
                <td>${esc(u.email)}</td>
                <td>
                    <select class="sel-role" ${u.email === me.email ? "disabled" : ""}>
                        <option value="user"  ${u.role === "user" ? "selected" : ""}>user</option>
                        <option value="staff" ${u.role === "staff" ? "selected" : ""}>staff</option>
                    </select>
                </td>
                <td class="muted">${fmtDate(u.created_at)}</td>
                <td>
                    <button class="btn btn-danger btn-del"
                            ${u.email === me.email ? "disabled" : ""}>ลบ</button>
                </td>
            </tr>`).join("");
    } catch (e) {
        if (String(e.message).includes("401")) return signOut();
        say("โหลดรายชื่อไม่สำเร็จ: " + e.message);
    }
}

/* ---------- จัดการคลิกในตาราง (event delegation จุดเดียว) ---------- */
$("userRows").addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".btn-del");
    if (!btn) return;
    const key = btn.closest("tr").dataset.key;
    if (!confirm(`ยืนยันลบบัญชี ${key} ?`)) return;
    try {
        await call(`/api/v1/admin/users/${encodeURIComponent(key)}`, { method: "DELETE" });
        say(`ลบ ${key} แล้ว`, true);
        loadUsers();
    } catch (e) { say("ลบไม่สำเร็จ: " + e.message); }
});

$("userRows").addEventListener("change", async (ev) => {
    const sel = ev.target.closest(".sel-role");
    if (!sel) return;
    const key = sel.closest("tr").dataset.key;
    try {
        await call(`/api/v1/admin/users/${encodeURIComponent(key)}/role`,
            { method: "PUT", body: { role: sel.value } });
        say(`เปลี่ยนสิทธิ์ ${key} เป็น ${sel.value} แล้ว`, true);
    } catch (e) {
        say("เปลี่ยนสิทธิ์ไม่สำเร็จ: " + e.message);
        loadUsers();
    }
});

/* ---------- ล็อกอิน ---------- */
$("formLogin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    say("");
    try {
        const r = await call("/api/v1/auth/login", {
            method: "POST",
            body: { email: $("inEmail").value.trim(), password: $("inPass").value },
        });
        if (r.user.role !== "staff") throw new Error("บัญชีนี้ไม่มีสิทธิ์เจ้าหน้าที่");
        setToken(r.access_token);
        me = r.user;
        $("inPass").value = "";
        render();
        loadUsers();
    } catch (e) { say(e.message); }
});

/* ---------- ออกจากระบบ ---------- */
function signOut() {
    setToken("");
    me = null;
    render();
    say("ออกจากระบบแล้ว", true);
}

$("btnLogout").addEventListener("click", signOut);
$("btnReload").addEventListener("click", loadUsers);

/* ---------- ตอนเปิดหน้า: มี token ค้างอยู่ไหม ---------- */
(async function boot() {
    if (getToken()) {
        try {
            const { user } = await call("/api/v1/auth/me");
            if (user.role === "staff") { me = user; render(); return loadUsers(); }
        } catch { /* token เสีย -> ตกไปหน้าล็อกอิน */ }
        setToken("");
    }
    render();
})();