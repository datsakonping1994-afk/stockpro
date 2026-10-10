// Cloudflare Worker + D1
//  - เจ้าของวง: ส่งรหัส PIN ใน header x-pin → อ่าน/แก้ข้อมูลทั้งหมด + อนุมัติผู้เล่น
//  - ผู้เล่น: สมัครด้วยชื่อ+รหัสของตัวเอง (ต้องให้เจ้าของวงอนุมัติ) → เห็นและแก้ได้เฉพาะรายการของตัวเอง
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-pin, x-name, x-code",
  "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
  "access-control-max-age": "86400",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
const hash = async (name, code) => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hilo|" + name + "|" + code));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const dec = (s) => { try { return decodeURIComponent(s || ""); } catch { return ""; } };
const SEL = "SELECT data, ver FROM doc WHERE id = 'main'";
const round2 = (n) => Math.round(n * 100) / 100;
const okAmt = (a) => Number.isFinite(a) && a !== 0 && Math.abs(a) <= 1e9;

// แก้เอกสารกลางแบบมีเวอร์ชัน (ชนกันจะลองใหม่)
async function mutate(env, fn) {
  for (let i = 0; i < 5; i++) {
    const row = await env.DB.prepare(SEL).first();
    if (!row) return { err: "nodoc" };
    const data = JSON.parse(row.data);
    const r0 = fn(data);
    if (r0 && r0.err) return r0;
    const r = await env.DB.prepare(
      "UPDATE doc SET data = ?1, ver = ver + 1 WHERE id = 'main' AND ver = ?2"
    ).bind(JSON.stringify(data), row.ver).run();
    if (r.meta.changes) return { data };
  }
  return { err: "busy" };
}
const view = (data, name) => {
  const mine = (data.ents || []).filter((e) => e.n === name);
  const by = {};
  for (const e of data.ents || []) if (e.n !== name) by[e.n] = (by[e.n] || 0) + (+e.a || 0);
  const others = Object.keys(by).map((n) => ({ name: n, total: round2(by[n]) })).sort((a, b) => b.total - a.total);
  return {
    status: "approved",
    name,
    others,
    web: round2((parseFloat(data.cap) || 0) + (+data.banked || 0) + (data.ents || []).reduce((t, e) => t + (+e.a || 0), 0)),
    total: round2(mine.reduce((t, e) => t + (+e.a || 0), 0)),
    entries: mine.map((e) => ({ a: e.a })).reverse(),
  };
};

let ready = false; // สร้างตารางครั้งเดียวต่อ instance ไม่ต้องทำทุกคำขอ

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!ready) {
      await env.DB.batch([
        env.DB.prepare("CREATE TABLE IF NOT EXISTS doc (id TEXT PRIMARY KEY, data TEXT NOT NULL, ver INTEGER NOT NULL)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS players (name TEXT PRIMARY KEY, h TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0)"),
      ]);
      ready = true;
    }
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const admin = !!env.PIN && request.headers.get("x-pin") === env.PIN;
    const body = async () => { try { return await request.json(); } catch { return null; } };

    // ---------- ผู้เล่นสมัคร/เข้าสู่ระบบ ----------
    if (path === "/join" && request.method === "POST") {
      const b = await body();
      const name = String((b && b.name) || "").trim().slice(0, 20);
      const code = String((b && b.code) || "");
      if (!name || code.length < 6) return json({ error: "bad" }, 400);
      const h = await hash(name, code);
      const p = await env.DB.prepare("SELECT h, ok FROM players WHERE name = ?1").bind(name).first();
      if (!p) {
        await env.DB.prepare("INSERT INTO players (name, h, ok) VALUES (?1, ?2, 0)").bind(name, h).run();
        return json({ status: "pending" });
      }
      if (p.h !== h) return json({ error: "taken" }, 403);
      return json({ status: p.ok ? "approved" : "pending" });
    }

    // ---------- ผู้เล่น: ดู/แก้ข้อมูลของตัวเอง ----------
    if (path === "/me") {
      const name = dec(request.headers.get("x-name"));
      const code = dec(request.headers.get("x-code"));
      // ถามผู้เล่นกับเอกสารพร้อมกัน ลดเวลารอ
      const pq = name && code ? env.DB.prepare("SELECT h, ok FROM players WHERE name = ?1").bind(name).first() : Promise.resolve(null);
      const dq = request.method === "GET" ? env.DB.prepare(SEL).first() : Promise.resolve(null);
      const [p, row] = await Promise.all([pq, dq]);
      if (!p || p.h !== (await hash(name, code))) return json({ error: "auth" }, 401);
      if (!p.ok) return json({ status: "pending" }, 403);

      if (request.method === "GET") {
        if (!row) return json({ error: "nodoc" }, 503);
        const qv = new URL(request.url).searchParams.get("v");
        if (qv !== null && +qv === row.ver) return json({ status: "approved", same: true, ver: row.ver });
        const out = view(JSON.parse(row.data), name);
        out.ver = row.ver;
        return json(out);
      }
      if (request.method !== "POST") return json({ error: "method" }, 405);
      const b = await body();
      if (!b) return json({ error: "bad" }, 400);
      const res = await mutate(env, (d) => {
        d.ents = d.ents || [];
        const before = JSON.stringify(d.ents);
        const log = (x) => {
          d.hist = d.hist || [];
          d.hist.unshift({ t: Date.now(), label: "ผู้เล่น", before, bk: +d.banked || 0, gtv: "", by: name, ...x });
          if (d.hist.length > 30) d.hist.length = 30;
        };
        if (b.op === "add") {
          const a = +b.a;
          if (!okAmt(a)) return { err: "bad" };
          d.ents.push({ id: crypto.randomUUID().slice(0, 8), n: name, a: round2(a), o: name });
          log({ k: "add", n: name, a: round2(a) });
        } else return { err: "bad" }; // ผู้เล่นแก้/ลบไม่ได้ ต้องให้เจ้าของวงทำ
      });
      if (res.err) return json({ error: res.err }, res.err === "nodoc" ? 503 : res.err === "busy" ? 409 : 400);
      return json(view(res.data, name));
    }

    // ---------- เจ้าของวงเท่านั้น ----------
    if (!admin) return json({ error: "pin" }, 401);

    if (path === "/players") {
      if (request.method === "GET") {
        const r = await env.DB.prepare("SELECT name, ok FROM players ORDER BY name").all();
        return json({ players: r.results.map((x) => ({ name: x.name, ok: !!x.ok })) });
      }
      if (request.method === "POST") {
        const b = await body();
        if (!b || !b.name) return json({ error: "bad" }, 400);
        if (b.action === "approve") await env.DB.prepare("UPDATE players SET ok = 1 WHERE name = ?1").bind(b.name).run();
        else if (b.action === "remove") await env.DB.prepare("DELETE FROM players WHERE name = ?1").bind(b.name).run();
        else return json({ error: "bad" }, 400);
        return json({ ok: true });
      }
      return json({ error: "method" }, 405);
    }

    const row = await env.DB.prepare(SEL).first();
    if (request.method === "GET") {
      const qv = new URL(request.url).searchParams.get("v");
      if (row && qv !== null && +qv === row.ver) return json({ ver: row.ver, same: true });
      return json({ ver: row ? row.ver : 0, data: row ? JSON.parse(row.data) : null });
    }
    if (request.method !== "PUT") return json({ error: "method" }, 405);

    const b = await body();
    if (!b) return json({ error: "bad" }, 400);
    const text = JSON.stringify(b.data || {});
    if (text.length > 800000) return json({ error: "too big" }, 413);
    const cur = row ? row.ver : 0;
    if (b.ver !== cur) return json({ ver: cur, data: row ? JSON.parse(row.data) : null }, 409);

    const stmt = row
      ? env.DB.prepare("UPDATE doc SET data = ?1, ver = ver + 1 WHERE id = 'main' AND ver = ?2").bind(text, cur)
      : env.DB.prepare("INSERT INTO doc (id, data, ver) VALUES ('main', ?1, 1) ON CONFLICT(id) DO NOTHING").bind(text);
    const r = await stmt.run();
    if (!r.meta.changes) {
      const n = await env.DB.prepare(SEL).first();
      return json({ ver: n.ver, data: JSON.parse(n.data) }, 409);
    }
    return json({ ver: cur + 1 });
  },
};
