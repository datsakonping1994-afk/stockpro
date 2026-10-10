// Cloudflare Worker + D1 : เก็บข้อมูลสมุดบัญชีไว้ที่เดียว ทุกเครื่องใช้ร่วมกัน
// ต้องผูก D1 ชื่อ DB และตั้งตัวแปร PIN (รหัสวง)
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-pin",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-max-age": "86400",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.PIN || request.headers.get("x-pin") !== env.PIN) return json({ error: "pin" }, 401);

    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS doc (id TEXT PRIMARY KEY, data TEXT NOT NULL, ver INTEGER NOT NULL)"
    ).run();
    const row = await env.DB.prepare("SELECT data, ver FROM doc WHERE id = 'main'").first();

    if (request.method === "GET")
      return json({ ver: row ? row.ver : 0, data: row ? JSON.parse(row.data) : null });
    if (request.method !== "PUT") return json({ error: "method" }, 405);

    let b;
    try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
    const text = JSON.stringify(b.data || {});
    if (text.length > 800000) return json({ error: "too big" }, 413);

    const cur = row ? row.ver : 0;
    if (b.ver !== cur) return json({ ver: cur, data: row ? JSON.parse(row.data) : null }, 409);

    const stmt = row
      ? env.DB.prepare("UPDATE doc SET data = ?1, ver = ver + 1 WHERE id = 'main' AND ver = ?2").bind(text, cur)
      : env.DB.prepare("INSERT INTO doc (id, data, ver) VALUES ('main', ?1, 1) ON CONFLICT(id) DO NOTHING").bind(text);
    const r = await stmt.run();
    if (!r.meta.changes) {
      const n = await env.DB.prepare("SELECT data, ver FROM doc WHERE id = 'main'").first();
      return json({ ver: n.ver, data: JSON.parse(n.data) }, 409);
    }
    return json({ ver: cur + 1 });
  },
};
