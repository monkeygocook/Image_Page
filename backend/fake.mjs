/* เซิร์ฟเวอร์ทดสอบ — ไม่ต้องติดตั้งอะไรเพิ่ม ใช้ Node เปล่า ๆ
   รัน: node backend/fake.mjs                                    */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = 5050;

createServer((req, res) => {
    // CORS — หน้าบ้านรันคนละ port จึงต้องเปิดให้
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    res.setHeader("X-Request-Id", randomUUID());

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url.startsWith("/api/v1/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.0.1-fake-node" }));
        return;
    }

    // endpoint อื่นยังไม่ทำ — ตอบตามรูปแบบ error ที่หน้าบ้านเข้าใจ
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        error: { code: "NOT_FOUND", message: "ยังไม่ได้ทำ endpoint นี้" }
    }));
}).listen(PORT, "0.0.0.0", () => console.log(`fake backend → http://172.20.56.154:${PORT}`));