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
        const e = new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
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
    $("viewJobs").hidden = !signedIn;
    signedIn ? startJobs() : stopJobs();
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

/* =============================================================
   แดชบอร์ดงาน — ใครกำลังทำงานอะไร  (GET /api/v1/admin/jobs)
   ============================================================= */
const JOBS_POLL_MS = 2000;
const TOOL_NAME = {
    "generate": "สร้างภาพ",
    "remove-background": "ลบพื้นหลัง",
    "adjust": "ปรับแสงสี",
    "filter": "ฟิลเตอร์",
    "blur": "เบลอ",
};
const LANE_NAME = { gen: "สายสร้างภาพ (gen)", img: "สายแต่งภาพ (img)" };
const STATUS_NAME = {
    running: "กำลังทำ", queued: "รอคิว", done: "สำเร็จ", error: "ผิดพลาด", cancelled: "ยกเลิก",
};
let jobsTimer = null;
let jobsBusy = false;

const secText = (s) => {
    if (s == null) return "-";
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} วิ`;
    return `${Math.floor(s / 60)} นาที ${Math.round(s % 60)} วิ`;
};

const fmtTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "-" : d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

// % ที่จะแสดง: ของจริงจาก Forge ถ้ามี ไม่งั้นประมาณจากเวลาเฉลี่ย (แสดงเป็นสีจาง)
function progressOf(j) {
    if (typeof j.progress === "number") return { pct: j.progress, est: false };
    if (j.status === "running" && j.avg_sec > 0 && j.run_sec != null) {
        return { pct: Math.min(99, Math.round(j.run_sec / j.avg_sec * 100)), est: true };
    }
    return null;
}

function statusCell(j) {
    let html = `<span class="badge ${esc(j.status)}">${esc(STATUS_NAME[j.status] || j.status)}</span>`;
    if (j.status === "queued" && j.position) {
        html += ` <span class="muted">คิวที่ ${j.position}${j.total ? ` จาก ${j.total}` : ""}</span>`;
    }
    const p = progressOf(j);
    if (j.status === "running" && p) {
        const eta = typeof j.eta_sec === "number" ? ` · เหลือ ~${secText(j.eta_sec)}` : "";
        html += ` <span class="num">${p.est ? "~" : ""}${p.pct}%${eta}</span>
            <div class="pbar ${p.est ? "est" : ""}"><span style="width:${p.pct}%"></span></div>`;
    }
    if (j.error) html += `<div class="muted">${esc(j.error.code)}: ${esc(j.error.message)}</div>`;
    return html;
}

const userCell = (j) =>
    `<td class="who"><b>${esc(j.user?.name)}</b><span class="muted">${esc(j.user?.email)}</span>
        ${j.ip && j.ip !== "-" ? `<div class="muted">IP ${esc(j.ip)}</div>` : ""}</td>`;

const toolCell = (j) =>
    `<td class="tool">${esc(TOOL_NAME[j.tool] || j.tool)}<span class="lane-tag">${esc(j.lane)}</span></td>`;

const optsText = (o = {}) =>
    Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(" · ") || "-";

function renderLanes(lanes = {}) {
    $("laneTiles").innerHTML = Object.entries(lanes).map(([name, l]) => {
        const cls = l.waiting >= l.max_waiting ? "full" : (l.running || l.waiting) ? "busy" : "";
        return `<div class="tile ${cls}">
            <div class="tile-title">${esc(LANE_NAME[name] || name)}</div>
            <div class="tile-nums">
                <div><b>${l.running}/${l.concurrency}</b><small>กำลังทำ</small></div>
                <div><b>${l.waiting}/${l.max_waiting}</b><small>รอคิว</small></div>
            </div>
        </div>`;
    }).join("");
}

async function loadJobs() {
    if (jobsBusy || !me) return;
    jobsBusy = true;
    try {
        const d = await call("/api/v1/admin/jobs");
        renderLanes(d.lanes);

        $("jobsEmpty").hidden = d.active.length > 0;
        $("jobRows").innerHTML = d.active.map((j) => `
            <tr>
                ${userCell(j)}
                ${toolCell(j)}
                <td>${statusCell(j)}</td>
                <td class="num">${secText(j.wait_sec)}</td>
                <td class="num">${j.run_sec == null ? "-" : secText(j.run_sec)}</td>
                <td class="opts">${esc(optsText(j.options))}</td>
            </tr>`).join("");

        $("recentCount").textContent = d.recent.length;
        $("recentMin").textContent = Math.round((d.recent_ttl_sec || 600) / 60);
        $("recentRows").innerHTML = d.recent.map((j) => `
            <tr>
                ${userCell(j)}
                ${toolCell(j)}
                <td>${statusCell(j)}</td>
                <td class="num">${secText(j.wait_sec)}</td>
                <td class="num">${j.run_sec == null ? "-" : secText(j.run_sec)}</td>
                <td class="num muted">${fmtTime(j.finished_at)}</td>
            </tr>`).join("");

        $("jobsUpdated").textContent = "อัปเดต " + fmtTime(d.now);
        $("jobsLive").className = "live" + ($("autoRefresh").checked ? " on" : "");
    } catch (e) {
        $("jobsLive").className = "live err";
        if (e.status === 401) return signOut();
        $("jobsUpdated").textContent = "โหลดไม่สำเร็จ: " + e.message;
    } finally {
        jobsBusy = false;
    }
}

function startJobs() {
    if (!jobsTimer) {
        loadJobs();
        jobsTimer = setInterval(() => {
            // ไม่ถามถ้าปิดอัปเดตอัตโนมัติ หรือแท็บถูกซ่อนอยู่
            if ($("autoRefresh").checked && !document.hidden) loadJobs();
        }, JOBS_POLL_MS);
    }
}

function stopJobs() {
    clearInterval(jobsTimer);
    jobsTimer = null;
}

$("btnJobsReload").addEventListener("click", loadJobs);
$("autoRefresh").addEventListener("change", () => {
    $("jobsLive").className = "live" + ($("autoRefresh").checked ? " on" : "");
    if ($("autoRefresh").checked) loadJobs();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && me) loadJobs(); });
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