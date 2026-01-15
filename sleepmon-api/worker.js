/**
 * SleepMon Cloudflare Worker API (R2 + D1)
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /telemetry            (auth)  JSON { ts, spo2, rms, alarmA }
 *  - GET  /telemetry/latest     (public by default)
 *  - GET  /telemetry/days?dates=YYYY-MM-DD,YYYY-MM-DD
 *  - POST /upload_wav           (auth)  bytes + headers X-Format=sma1, X-Filename, X-Timestamp
 *  - GET  /abnormal/list?days=7
 *  - GET  /abnormal/get?key=...
 *
 * Bindings (wrangler.toml):
 *  - DB: D1 database
 *  - R2: R2 bucket
 *  - AUTH_TOKEN: env var (string)
 *
 * Notes:
 *  - GET routes can be public, while POST routes require Bearer token.
 *  - You can flip READ_PUBLIC to false to require auth on reads.
 */
const READ_PUBLIC = true;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Format,X-Filename,X-Timestamp",
};

function json(data, status=200, extraHeaders={}){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type":"application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders }
  });
}

function text(data, status=200, extraHeaders={}){
  return new Response(data, { status, headers: { "Content-Type":"text/plain; charset=utf-8", ...CORS_HEADERS, ...extraHeaders } });
}

function bad(msg, status=400){ return json({ ok:false, error: msg }, status); }

function requireAuth(req, env){
  const h = req.headers.get("Authorization") || "";
  const want = "Bearer " + (env.AUTH_TOKEN || "");
  if (!env.AUTH_TOKEN) return false; // if token not set, fail auth
  return h === want;
}

function mustAuth(req, env){
  if (!requireAuth(req, env)) throw new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
}

function getTzDayFromEpochSec(ts){
  // derive YYYY-MM-DD in Hanoi (+07:00) from epoch seconds
  const d = new Date(ts * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);

  const get = (t) => fmt.find(p => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayStartEndSec(isoDay){
  // isoDay: YYYY-MM-DD (Hanoi)
  const startMs = Date.parse(`${isoDay}T00:00:00+07:00`);
  if (!Number.isFinite(startMs)) return null;
  return { start: Math.floor(startMs/1000), end: Math.floor(startMs/1000) + 86400 };
}

async function ensureSchema(db){
  // safe to call; uses IF NOT EXISTS
  const schema = `
    CREATE TABLE IF NOT EXISTS telemetry (
      ts INTEGER NOT NULL PRIMARY KEY,
      spo2 REAL,
      rms REAL,
      alarmA INTEGER
    );
    CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts);

    CREATE TABLE IF NOT EXISTS abnormal_files (
      key TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      filename TEXT,
      size_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS abnormal_ts ON abnormal_files(ts);
  `;
  // D1 doesn't support multiple statements in one prepare in some cases; execute sequentially
  for (const stmt of schema.split(";").map(s=>s.trim()).filter(Boolean)){
    await db.exec(stmt + ";");
  }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS_HEADERS });

    const url = new URL(req.url);
    const path = url.pathname;

    try{
      // Health
      if (req.method === "GET" && path === "/health"){
        return json({ ok:true, now: Math.floor(Date.now()/1000) });
      }

      // Telemetry POST
      if (req.method === "POST" && path === "/telemetry"){
        mustAuth(req, env);

        if (!env.DB) return bad("Missing D1 binding DB", 500);
        await ensureSchema(env.DB);

        const body = await req.json().catch(()=>null);
        if (!body || typeof body !== "object") return bad("Invalid JSON");
        const ts = Number(body.ts || Math.floor(Date.now()/1000));
        const spo2 = (body.spo2 === null || body.spo2 === undefined) ? null : Number(body.spo2);
        const rms  = (body.rms  === null || body.rms  === undefined) ? null : Number(body.rms);
        const alarmA = (body.alarmA === null || body.alarmA === undefined) ? null : Number(body.alarmA);

        if (!Number.isFinite(ts) || ts <= 0) return bad("Bad ts");
        const stmt = env.DB.prepare(
          "INSERT OR REPLACE INTO telemetry (ts, spo2, rms, alarmA) VALUES (?, ?, ?, ?)"
        );
        await stmt.bind(ts, spo2, rms, alarmA).run();
        return json({ ok:true });
      }

      // Telemetry latest
      if (req.method === "GET" && path === "/telemetry/latest"){
        if (!READ_PUBLIC) mustAuth(req, env);

        if (!env.DB) return bad("Missing D1 binding DB", 500);
        await ensureSchema(env.DB);

        const row = await env.DB.prepare(
          "SELECT ts, spo2, rms, alarmA FROM telemetry ORDER BY ts DESC LIMIT 1"
        ).first();

        return json({ ok:true, point: row || null });
      }

      // Telemetry days
      if (req.method === "GET" && path === "/telemetry/days"){
        if (!READ_PUBLIC) mustAuth(req, env);

        if (!env.DB) return bad("Missing D1 binding DB", 500);
        await ensureSchema(env.DB);

        const datesParam = url.searchParams.get("dates") || "";
        const dates = datesParam.split(",").map(s=>s.trim()).filter(Boolean);
        if (!dates.length) return json({ ok:true, days: {} });

        const out = {};
        for (const d of dates){
          const rng = dayStartEndSec(d);
          if (!rng) { out[d] = []; continue; }

          const rows = await env.DB.prepare(
            "SELECT ts, spo2, rms, alarmA FROM telemetry WHERE ts >= ? AND ts < ? ORDER BY ts ASC"
          ).bind(rng.start, rng.end).all();

          out[d] = rows.results || [];
        }

        return json({ ok:true, days: out });
      }

      // Upload abnormal audio (SMA1)
      if (req.method === "POST" && path === "/upload_wav"){
        mustAuth(req, env);
        if (!env.R2) return bad("Missing R2 binding R2", 500);
        if (!env.DB) return bad("Missing D1 binding DB", 500);
        await ensureSchema(env.DB);

        const fmt = (req.headers.get("X-Format") || "").toLowerCase();
        if (fmt !== "sma1") return bad("X-Format must be sma1", 400);

        const filename = req.headers.get("X-Filename") || "abnormal.sma";
        const ts = Number(req.headers.get("X-Timestamp") || Math.floor(Date.now()/1000));
        if (!Number.isFinite(ts) || ts <= 0) return bad("Bad X-Timestamp", 400);

        const buf = await req.arrayBuffer();
        const size = buf.byteLength;

        const day = getTzDayFromEpochSec(ts);
        const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const key = `abnormal/${day}/${ts}_${safeName}`;

        await env.R2.put(key, buf, {
          httpMetadata: { contentType: "application/octet-stream" }
        });

        await env.DB.prepare(
          "INSERT OR REPLACE INTO abnormal_files (key, ts, filename, size_bytes) VALUES (?, ?, ?, ?)"
        ).bind(key, ts, filename, size).run();

        return json({ ok:true, key, size_bytes: size });
      }

      // List abnormal
      if (req.method === "GET" && path === "/abnormal/list"){
        if (!READ_PUBLIC) mustAuth(req, env);

        if (!env.DB) return bad("Missing D1 binding DB", 500);
        await ensureSchema(env.DB);

        const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") || 7)));
        const cutoff = Math.floor(Date.now()/1000) - days * 86400;

        const rows = await env.DB.prepare(
          "SELECT key as r2_key, ts, filename, size_bytes FROM abnormal_files WHERE ts >= ? ORDER BY ts DESC"
        ).bind(cutoff).all();

        return json({ ok:true, items: rows.results || [] });
      }

      // Get abnormal raw
      if (req.method === "GET" && path === "/abnormal/get"){
        if (!READ_PUBLIC) mustAuth(req, env);

        if (!env.R2) return bad("Missing R2 binding R2", 500);
        const key = url.searchParams.get("key") || "";
        if (!key.startsWith("abnormal/")) return bad("Bad key", 400);

        const obj = await env.R2.get(key);
        if (!obj) return bad("Not found", 404);

        const headers = new Headers({ ...CORS_HEADERS });
        headers.set("Content-Type", "application/octet-stream");
        return new Response(obj.body, { status: 200, headers });
      }

      return bad("Not found", 404);
    }catch(e){
      if (e instanceof Response) return e;
      return bad(String(e && e.message ? e.message : e), 500);
    }
  }
};
