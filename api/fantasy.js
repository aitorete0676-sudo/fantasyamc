// Almazora C Fantasy · servidor en Vercel (Upstash Redis). Cuentas, dinero, plantillas, pujas, precios y jornadas.
// Todo lo importante (dinero, quién tiene a quién, pujas) se decide aquí, no en el móvil de cada uno.
const crypto = require("crypto");
const G = require("../game.js");
const LIGA = require("../liga.json");

const envKey = suf => process.env["KV" + suf] ? "KV" + suf : Object.keys(process.env).find(k => k.endsWith(suf) && !k.includes("READ_ONLY"));
const URL_ = process.env[envKey("_REST_API_URL")] || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env[envKey("_REST_API_TOKEN")] || process.env.UPSTASH_REDIS_REST_TOKEN;

const P = "fa2:";   // prefijo de todas las claves (no se mezcla con AlmaBet ni con otras apps)
async function redis(...cmd) {
  if (cmd.length > 1) cmd[1] = P + cmd[1];
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
const getJ = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
const setJ = (k, v) => redis("SET", k, JSON.stringify(v));
async function hgetall(k) { const h = (await redis("HGETALL", k)) || []; const o = {}; for (let i = 0; i < h.length; i += 2) o[h[i]] = JSON.parse(h[i + 1]); return o; }
const norm = u => String(u || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]/g, "");
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };

/* ---------- jugadores ---------- */
const PL = {}; LIGA.players.forEach(p => PL[p.id] = p);
let POSO = {};   // posiciones corregidas por el admin
const posOf = id => POSO[id] || (PL[id] || {}).pos || "CEN";
// Puntos de cada jugador en J1–J8 (actas) → precio inicial
function seasonPts(id, extraJ) { let s = 0; Object.values(LIGA.jornadas).concat(extraJ || []).forEach(J => s += G.points(posOf(id), J, id)); return s; }
async function allJornadas() { const imp = await hgetall("jornadas"); const o = {}; Object.values(LIGA.jornadas).forEach(J => o[J.n] = J); Object.values(imp).forEach(J => o[J.n] = J); return o; }

/* ---------- sesiones ---------- */
async function newSession(name) { const t = crypto.randomBytes(24).toString("hex"); await redis("SET", "sess:" + t, name, "EX", 60 * 60 * 24 * 365); return t; }
async function whoami(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, ""); if (!t) return null;
  const name = await redis("GET", "sess:" + t); if (!name) return null;
  const u = await getJ("user:" + name); return u ? { name, ...u } : null;
}
async function log(type, text) { await redis("LPUSH", "log", JSON.stringify({ type, text, at: Date.now() })); await redis("LTRIM", "log", 0, 299); }

/* ---------- precios ---------- */
// prices = { day, v:{id:valor}, prev:{id:valor de ayer}, h:{id:[últimos 30 valores]}, pub:[jornadas ya aplicadas] }
async function getPrices() {
  let pr = await getJ("prices");
  if (!pr) { pr = { day: G.day(Date.now()), v: {}, prev: {}, h: {}, pub: [] };
    LIGA.players.forEach(p => { const v = G.baseValue(seasonPts(p.id)); pr.v[p.id] = v; pr.prev[p.id] = v; pr.h[p.id] = [v]; });
    await setJ("prices", pr); }
  return pr;
}

/* ---------- cambio de día: se cierran las pujas, cambian los precios y sale mercado nuevo ---------- */
async function tick() {
  const today = G.day(Date.now()), pr = await getPrices();
  let market = await getJ("market");
  if (market && pr.day === today && market.day === today) return;
  if (!(await redis("SET", "lock:tick", "1", "NX", "EX", 30))) return;
  try {
    const owner = (await redis("HGETALL", "owner")) || [], own = {}; for (let i = 0; i < owner.length; i += 2) own[owner[i]] = owner[i + 1];
    const demand = {}, unsold = {};
    // 1) cerrar subastas vencidas
    if (market) {
      const keep = [];
      for (const it of market.items) {
        if (it.ends > Date.now()) { keep.push(it); continue; }
        const bids = await hgetall("bids:" + it.pid); await redis("DEL", "bids:" + it.pid);
        const list = Object.entries(bids).map(([u, b]) => ({ u, ...b })).sort((a, b) => b.amount - a.amount || a.at - b.at);
        demand[it.pid] = list.length;
        let done = false;
        for (const b of list) {
          if (b.u === it.seller) continue;
          const t = await getJ("team:" + b.u); if (!t || t.money < b.amount || t.squad.length >= G.MAX_SQUAD) continue;
          if (it.seller !== "LIGA") { const s = await getJ("team:" + it.seller);
            if (!s || !s.squad.includes(it.pid)) break;
            s.squad = s.squad.filter(x => x !== it.pid); s.money += b.amount; dropFromLineups(s, it.pid); await setJ("team:" + it.seller, s); }
          else if (own[it.pid]) break;
          t.money -= b.amount; t.squad.push(it.pid); await setJ("team:" + b.u, t); await redis("HSET", "owner", it.pid, b.u); own[it.pid] = b.u;
          await log("market", `${t.name || b.u} ha comprado a ${PL[it.pid].n} a ${it.seller === "LIGA" ? "LIGA" : it.seller} por ${b.amount.toLocaleString("es-ES")}€` + (list.length > 1 ? ` (${list.length} pujas)` : ""));
          done = true; break;
        }
        if (!done && it.seller !== "LIGA") unsold[it.pid] = 1;
      }
      market.items = keep;
    }
    // 2) precios: oferta y demanda + rendimiento de la última jornada publicada
    if (pr.day !== today) {
      const J = await allJornadas(), fresh = Object.values(J).filter(j => j.n >= G.FIRST_J && j.publicada && !pr.pub.includes(j.n));
      LIGA.players.forEach(p => {
        let ch = Math.min(0.15, 0.04 * (demand[p.id] || 0)) - (unsold[p.id] ? 0.03 : 0) + (own[p.id] ? 0.005 : 0);
        fresh.forEach(j => { const s = j.st && j.st[p.id]; if (s && s[1] > 0) ch += Math.max(-0.15, Math.min(0.25, (G.points(posOf(p.id), j, p.id) - 3) * 0.04)); else ch -= 0.02; });
        const v0 = pr.v[p.id] || G.baseValue(0), v = Math.max(300000, Math.round(v0 * (1 + ch) / 1000) * 1000);
        pr.prev[p.id] = v0; pr.v[p.id] = v; pr.h[p.id] = (pr.h[p.id] || []).concat(v).slice(-30);
      });
      fresh.forEach(j => pr.pub.push(j.n)); pr.day = today; await setJ("prices", pr);
    }
    // 3) mercado nuevo: jugadores libres al azar (más probables los que juegan)
    const ends = G.nextMidnight(Date.now()), inMk = new Set((market ? market.items : []).map(i => i.pid));
    const free = LIGA.players.filter(p => !own[p.id] && !inMk.has(p.id));
    const pick = []; const pool = free.map(p => ({ p, w: Math.random() * (1 + Math.min(4, (pr.v[p.id] || 0) / 4e6)) })).sort((a, b) => b.w - a.w);
    pool.slice(0, G.MARKET_SIZE).forEach(x => pick.push({ pid: x.p.id, seller: "LIGA", price: pr.v[x.p.id], ends }));
    market = { day: today, items: (market ? market.items : []).concat(pick) };
    await setJ("market", market);
  } finally { await redis("DEL", "lock:tick"); }
}
function dropFromLineups(t, pid) { Object.values(t.lineups || {}).forEach(l => { l.s = (l.s || []).map(x => x === pid ? null : x); if (l.c === pid) l.c = null; }); }

/* ---------- jornada en juego y cierre de alineaciones ---------- */
function currentJ(J) {
  let n = G.FIRST_J; while (J[n] && J[n].publicada) n++;
  const cal = LIGA.calendar[n] || [], kick = cal.map(m => G.madridTs(m[2])).filter(x => x > 0);
  return { n, lock: kick.length ? Math.min(...kick) : null, matches: cal };
}

/* ---------- equipo nuevo: 100 M y una plantilla aleatoria de unos 100 M ---------- */
async function newTeam(name) {
  const pr = await getPrices(), owner = (await redis("HGETALL", "owner")) || [], taken = new Set(owner.filter((_, i) => i % 2 === 0));
  const mk = await getJ("market"); (mk ? mk.items : []).forEach(i => taken.add(i.pid));
  let best = null;
  for (let tries = 0; tries < 300; tries++) {
    const squad = []; let val = 0;
    for (const [pos, n] of Object.entries(G.START_SQUAD)) {
      const pool = LIGA.players.filter(p => posOf(p.id) === pos && !taken.has(p.id) && !squad.includes(p.id)).sort(() => Math.random() - 0.5);
      pool.slice(0, n).forEach(p => { squad.push(p.id); val += pr.v[p.id]; });
    }
    const err = Math.abs(val - G.START_VALUE);
    if (!best || err < best.err) best = { squad, err };
    if (err < 3e6) break;
  }
  for (const id of best.squad) await redis("HSET", "owner", id, name);
  return { name: "", money: G.START_MONEY, squad: best.squad, lineups: {}, daily: "", joined: Date.now() };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => res.status(code).json(obj);
  if (!URL_ || !TOKEN) return send(500, { error: "Falta conectar la base de datos: en Vercel ve a Storage > Upstash for Redis > Connect y vuelve a desplegar." });
  try {
    let b = req.body || {}; if (typeof b === "string") b = JSON.parse(b || "{}");
    const a = b.action;
    POSO = (await getJ("pos")) || {};

    if (a === "register" || a === "login") {
      const name = norm(b.username), pw = String(b.password || "");
      if (name.length < 2 || name.length > 20 || pw.length < 6) return send(400, { error: "El usuario necesita 2 a 20 letras y la contraseña 6 caracteres o más." });
      if (a === "register") {
        const salt = crypto.randomBytes(16).toString("hex");
        const ok = await redis("SET", "user:" + name, JSON.stringify({ salt, hash: hash(pw, salt), admin: false, created: Date.now() }), "NX");
        if (!ok) return send(409, { error: "Ese usuario ya existe. Prueba a entrar." });
        const first = (await redis("SADD", "users", name)) && (await redis("SCARD", "users")) === 1;
        if (first || norm(process.env.ADMIN_USER) === name) { const u = await getJ("user:" + name); u.admin = true; await setJ("user:" + name, u); }
        await tick(); const t = await newTeam(name); await setJ("team:" + name, t);
        await log("join", `${name} se ha unido a la liga`);
      } else {
        let u = await getJ("user:" + name);
        if (!u) {   // cuenta de la primera versión (prefijo "fa:"): se pasa a la nueva con la misma contraseña
          const raw = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(["GET", "fa:user:" + name]) }).then(r => r.json()).catch(() => ({}));
          const old = raw && raw.result ? JSON.parse(raw.result) : null;
          if (old && hash(pw, old.salt) === old.hash) {
            u = { salt: old.salt, hash: old.hash, admin: false, created: Date.now() };
            await redis("SET", "user:" + name, JSON.stringify(u), "NX");
            const first = (await redis("SADD", "users", name)) && (await redis("SCARD", "users")) === 1;
            if (first || norm(process.env.ADMIN_USER) === name) { u.admin = true; await setJ("user:" + name, u); }
            await tick(); await setJ("team:" + name, await newTeam(name)); await log("join", `${name} se ha unido a la liga`);
          }
        }
        if (!u || hash(pw, u.salt) !== u.hash) return send(401, { error: "Usuario o contraseña incorrectos." });
      }
      return send(200, { token: await newSession(name) });
    }

    const me = await whoami(req);
    if (!me) return send(401, { error: "Sesión caducada. Vuelve a entrar." });
    const admin = me.admin || norm(process.env.ADMIN_USER) === me.name;
    await tick();
    const myKey = "team:" + me.name;
    let mine = await getJ(myKey);
    if (!mine) { mine = await newTeam(me.name); await setJ(myKey, mine); }
    const J = await allJornadas(), cur = currentJ(J), locked = cur.lock && Date.now() >= cur.lock;

    if (a === "state") {
      const users = (await redis("SMEMBERS", "users")) || [];
      const [pr, market, points, logs, ownerArr] = await Promise.all([getPrices(), getJ("market"), hgetall("points"), redis("LRANGE", "log", 0, 149), redis("HGETALL", "owner")]);
      const owner = {}; for (let i = 0; i < (ownerArr || []).length; i += 2) owner[ownerArr[i]] = ownerArr[i + 1];
      const teams = {};
      for (const u of users) { const t = u === me.name ? mine : await getJ("team:" + u); if (!t) continue;
        teams[u] = { name: t.name, squad: t.squad, lineups: t.lineups }; }   // el dinero de los demás no se enseña
      const myBids = {}; for (const it of (market ? market.items : [])) { const v = await redis("HGET", "bids:" + it.pid, me.name); if (v) myBids[it.pid] = JSON.parse(v).amount; }
      const imported = {}; Object.values(J).filter(j => j.n >= G.FIRST_J).forEach(j => imported[j.n] = j);
      return send(200, { me: me.name, admin, now: Date.now(), team: mine, teams, owner, prices: { v: pr.v, prev: pr.prev, h: pr.h }, market: market ? market.items : [],
        myBids, points, log: (logs || []).map(x => JSON.parse(x)), jornadas: imported, current: { ...cur, locked: !!locked }, pos: POSO });
    }
    if (a === "teamName") { mine.name = String(b.name || "").trim().slice(0, 28); await setJ(myKey, mine); return send(200, { ok: true }); }
    if (a === "daily") {
      const d = G.day(Date.now()); if (mine.daily === d) return send(400, { error: "Ya has recogido la recompensa de hoy." });
      mine.daily = d; mine.money += G.DAILY; await setJ(myKey, mine); return send(200, { ok: true });
    }
    if (a === "lineup") {
      if (locked) return send(400, { error: "La jornada " + cur.n + " ya ha empezado. Podrás cambiar la alineación cuando se publiquen los puntos." });
      const f = G.FORMS[b.f] ? b.f : "4-4-2", rows = G.FORMS[f], s = (Array.isArray(b.s) ? b.s : []).slice(0, 11);
      const need = ["POR"].concat(Array(rows[0]).fill("DEF"), Array(rows[1]).fill("CEN"), Array(rows[2]).fill("DEL"));
      const clean = need.map((pos, i) => { const id = s[i]; return id && mine.squad.includes(id) && posOf(id) === pos ? id : null; });
      if (new Set(clean.filter(Boolean)).size !== clean.filter(Boolean).length) return send(400, { error: "Un jugador está repetido." });
      mine.lineups = mine.lineups || {}; mine.lineups[cur.n] = { f, s: clean, c: clean.includes(b.c) ? b.c : null };
      await setJ(myKey, mine); return send(200, { ok: true });
    }
    if (a === "bid") {
      const market = await getJ("market"), it = (market ? market.items : []).find(i => i.pid === b.pid);
      if (!it || it.ends <= Date.now()) return send(400, { error: "Ese jugador ya no está en el mercado." });
      if (it.seller === me.name) return send(400, { error: "No puedes pujar por tu propio jugador." });
      if (b.amount == null || +b.amount === 0) { await redis("HDEL", "bids:" + b.pid, me.name); return send(200, { ok: true }); }
      const amount = Math.round(+b.amount);
      if (!(amount >= it.price)) return send(400, { error: "La puja mínima es " + it.price.toLocaleString("es-ES") + " €." });
      let others = 0; for (const x of market.items) { if (x.pid === b.pid) continue; const v = await redis("HGET", "bids:" + x.pid, me.name); if (v) others += JSON.parse(v).amount; }
      if (amount + others > mine.money) return send(400, { error: "Con tus otras pujas no te llega el saldo (" + mine.money.toLocaleString("es-ES") + " €)." });
      if (mine.squad.length >= G.MAX_SQUAD) return send(400, { error: "Tienes el máximo de " + G.MAX_SQUAD + " jugadores." });
      await redis("HSET", "bids:" + b.pid, me.name, JSON.stringify({ amount, at: Date.now() })); return send(200, { ok: true });
    }
    if (a === "sell" || a === "list" || a === "unlist") {
      if (!mine.squad.includes(b.pid)) return send(400, { error: "Ese jugador no es tuyo." });
      const pr = await getPrices(), v = pr.v[b.pid], market = (await getJ("market")) || { day: G.day(Date.now()), items: [] };
      const inL = cur.lock && locked && G.lineupFor(mine, cur.n).s.includes(b.pid);
      if (a === "sell") {
        if (inL) return send(400, { error: "Está en tu alineación de una jornada en juego." });
        market.items = market.items.filter(i => !(i.pid === b.pid && i.seller === me.name)); await setJ("market", market); await redis("DEL", "bids:" + b.pid);
        mine.squad = mine.squad.filter(x => x !== b.pid); mine.money += v; dropFromLineups(mine, b.pid); await setJ(myKey, mine); await redis("HDEL", "owner", b.pid);
        await log("market", `${mine.name || me.name} ha vendido a ${PL[b.pid].n} a LIGA por ${v.toLocaleString("es-ES")}€`);
      } else if (a === "list") {
        if (market.items.some(i => i.pid === b.pid)) return send(400, { error: "Ya está en el mercado." });
        const price = Math.max(v, Math.round(+b.price || v));
        market.items.push({ pid: b.pid, seller: me.name, price, ends: G.nextMidnight(Date.now()) }); await setJ("market", market);
      } else { market.items = market.items.filter(i => !(i.pid === b.pid && i.seller === me.name)); await setJ("market", market); await redis("DEL", "bids:" + b.pid); }
      return send(200, { ok: true });
    }
    // ---- administrador ----
    if (a === "importJornada" || a === "unpublish" || a === "setPos") {
      if (!admin) return send(403, { error: "Solo el administrador puede hacer esto." });
      if (a === "setPos") { if (!PL[b.pid] || !G.GOL[b.pos]) return send(400, { error: "Datos no válidos." }); POSO[b.pid] = b.pos; await setJ("pos", POSO); return send(200, { ok: true }); }
      const n = parseInt((b.jornada || b).n, 10); if (!(n >= G.FIRST_J && n <= 40)) return send(400, { error: "Jornada no válida." });
      const users = (await redis("SMEMBERS", "users")) || [], prevPts = (await hgetall("points"))[n] || {};
      if (a === "unpublish") {
        for (const u of users) { const t = await getJ("team:" + u); if (!t) continue; t.money -= Math.max(0, prevPts[u] || 0) * G.PER_POINT; await setJ("team:" + u, t); }
        await redis("HDEL", "jornadas", String(n)); await redis("HDEL", "points", String(n)); return send(200, { ok: true });
      }
      const jj = b.jornada; if (!jj || !Array.isArray(jj.matches) || typeof jj.st !== "object") return send(400, { error: "Faltan los partidos o las estadísticas." });
      const Jn = { n, matches: jj.matches, st: jj.st, publicada: Date.now() };
      await redis("HSET", "jornadas", String(n), JSON.stringify(Jn));
      const pts = {}, logs = [];
      for (const u of users) { const t = await getJ("team:" + u); if (!t) continue;
        const r = G.teamPoints(t, Jn, posOf); pts[u] = r.total;
        t.money += (Math.max(0, r.total || 0) - Math.max(0, prevPts[u] || 0)) * G.PER_POINT; await setJ("team:" + u, t);
        logs.push(r.total == null ? ["nopts", `En la jornada ${n}, ${t.name || u} no ha puntuado debido a alineación incompleta.`]
          : ["reward", `En la jornada ${n}, ${t.name || u} ha ganado ${(Math.max(0, r.total) * G.PER_POINT).toLocaleString("es-ES")}€ (${r.total} puntos)`]); }
      await redis("HSET", "points", String(n), JSON.stringify(pts));
      for (const [t, x] of logs) await log(t, x);
      await log("jornada", `Puntos de la jornada ${n} publicados.`);
      return send(200, { ok: true, points: pts });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
