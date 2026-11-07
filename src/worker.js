import { IDS } from "./platforms.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 15;
const VOTER_COOKIE_DAYS = 365;
const STANDINGS_TTL = 60; // seconds the standings response is cached at the edge
const enc = new TextEncoder();

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/api/standings" && req.method === "GET") return await standings(req, env, ctx);
      if (path === "/api/me" && req.method === "GET") return await me(req, env);
      if (path === "/api/vote" && req.method === "POST") return await vote(req, env);
      if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(hourly(env));
  },
};

/* ---------------- standings ---------------- */

async function standings(req, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/api/standings", req.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const [tallies, hist] = await env.DB.batch([
    env.DB.prepare("SELECT platform, count FROM tallies"),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'history'"),
  ]);
  const counts = emptyCounts();
  for (const r of tallies.results) if (r.platform in counts) counts[r.platform] = Math.max(0, r.count | 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const revealAt = toInt(env.REVEAL_AT, 0);
  const revealed = total >= revealAt;
  let history = [];
  if (revealed && hist.results[0]) {
    try { history = JSON.parse(hist.results[0].value); } catch { history = []; }
  }

  const body = {
    now: Date.now(),
    total,
    revealAt,
    revealed,
    counts: revealed ? counts : null,
    history,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  };
  const res = json(body, 200, { "Cache-Control": `public, max-age=${STANDINGS_TTL}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* ---------------- me + vote ---------------- */

async function me(req, env) {
  const voter = await voterFromCookie(req, env);
  if (!voter) return json({ vote: null, nextSwitchAt: 0 }, 200, { "Cache-Control": "no-store" });
  const row = await env.DB.prepare("SELECT platform, updated_at FROM votes WHERE user_id = ?").bind(voter).first();
  const cooldown = toInt(env.SWITCH_COOLDOWN_MIN, 0) * 60e3;
  return json(
    { vote: row ? row.platform : null, nextSwitchAt: row ? row.updated_at + cooldown : 0 },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function vote(req, env) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const platform = body && body.platform;
  if (!IDS.includes(platform)) return json({ error: "unknown_platform" }, 400);

  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!(await verifyTurnstile(body.token, ip, env))) return json({ error: "bot_check_failed" }, 403);

  const now = Date.now();
  const cooldown = toInt(env.SWITCH_COOLDOWN_MIN, 0) * 60e3;
  let voter = await voterFromCookie(req, env);
  const headers = {};

  const cur = voter
    ? await env.DB.prepare("SELECT platform, updated_at FROM votes WHERE user_id = ?").bind(voter).first()
    : null;

  // Moving an existing vote
  if (cur) {
    if (cur.platform === platform) {
      return json({ ok: true, vote: platform, previous: platform, nextSwitchAt: cur.updated_at + cooldown });
    }
    if (now - cur.updated_at < cooldown) {
      return json({ error: "cooldown", vote: cur.platform, nextSwitchAt: cur.updated_at + cooldown }, 429);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE votes SET platform = ?, updated_at = ? WHERE user_id = ? AND platform = ?")
        .bind(platform, now, voter, cur.platform),
      env.DB.prepare("UPDATE tallies SET count = MAX(count - 1, 0) WHERE platform = ?").bind(cur.platform),
      incTally(env, platform),
    ]);
    return json({ ok: true, vote: platform, previous: cur.platform, nextSwitchAt: now + cooldown });
  }

  // A new vote: cap how many new voters one network can add per day.
  // The cap is generous so shared mobile and office networks still work.
  const day = Math.floor(now / DAY);
  const ipKey = (await hmac(env.ID_SALT, `ip:${ip}:${day}`)).slice(0, 24);
  const cap = toInt(env.IP_DAILY_CAP, 0);
  if (cap > 0) {
    const row = await env.DB.prepare("SELECT n FROM ip_daily WHERE k = ?").bind(ipKey).first();
    if (row && row.n >= cap) return json({ error: "network_cap" }, 429);
  }

  if (!voter) {
    voter = b64url(crypto.getRandomValues(new Uint8Array(18)));
    // Production is always https; plain http only happens in local dev on a LAN address.
    const secure = new URL(req.url).protocol === "https:";
    headers["Set-Cookie"] = [
      cookie("sl_v", await signVoter(voter, env), { maxAge: VOTER_COOKIE_DAYS * 86400, httpOnly: true, secure }),
      cookie("sl_in", "1", { maxAge: VOTER_COOKIE_DAYS * 86400, secure }),
    ];
  }

  await env.DB.batch([
    env.DB.prepare("INSERT INTO votes (user_id, platform, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(voter, platform, now, now),
    incTally(env, platform),
    env.DB.prepare(
      "INSERT INTO ip_daily (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1",
    ).bind(ipKey, day),
  ]);
  return json({ ok: true, vote: platform, previous: null, nextSwitchAt: now + cooldown }, 200, headers);
}

function incTally(env, platform) {
  return env.DB.prepare(
    "INSERT INTO tallies (platform, count) VALUES (?, 1) ON CONFLICT(platform) DO UPDATE SET count = count + 1",
  ).bind(platform);
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return true; // not configured (local dev)
  if (!token || typeof token !== "string") return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.success === true;
}

/* ---------------- hourly cron ---------------- */

async function hourly(env) {
  const now = Date.now();
  // Recount from the source of truth so tallies never drift.
  const { results } = await env.DB.prepare("SELECT platform, COUNT(*) AS n FROM votes GROUP BY platform").all();
  const counts = emptyCounts();
  for (const r of results) if (r.platform in counts) counts[r.platform] = r.n;

  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'history'").first();
  let history = [];
  if (row) { try { history = JSON.parse(row.value); } catch { history = []; } }
  const ts = Math.floor(now / HOUR) * HOUR;
  history = history.filter((h) => h.t >= now - HISTORY_DAYS * DAY && h.t !== ts);
  history.push({ t: ts, c: counts });

  await env.DB.batch([
    ...IDS.map((id) =>
      env.DB.prepare(
        "INSERT INTO tallies (platform, count) VALUES (?, ?) ON CONFLICT(platform) DO UPDATE SET count = excluded.count",
      ).bind(id, counts[id]),
    ),
    env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('history', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(JSON.stringify(history)),
    env.DB.prepare("DELETE FROM ip_daily WHERE day < ?").bind(Math.floor(now / DAY) - 1),
  ]);
}

/* ---------------- voter cookie ---------------- */

async function signVoter(id, env) {
  return `${id}.${await hmac(env.SESSION_SECRET, `voter:${id}`)}`;
}

async function voterFromCookie(req, env) {
  const raw = getCookie(req, "sl_v");
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const expected = await hmac(env.SESSION_SECRET, `voter:${id}`);
  return safeEqual(expected, sig) ? id : null;
}

/* ---------------- helpers ---------------- */

function emptyCounts() {
  return Object.fromEntries(IDS.map((id) => [id, 0]));
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function json(data, status = 200, extra = {}) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function sameOrigin(req) {
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(req.url).origin;
}

function getCookie(req, name) {
  const header = req.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookie(name, value, { maxAge, httpOnly = false, secure = true }) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  if (secure) c += "; Secure";
  if (httpOnly) c += "; HttpOnly";
  return c;
}

async function hmac(secret, message) {
  if (!secret) throw new Error("Missing secret: set SESSION_SECRET and ID_SALT");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
