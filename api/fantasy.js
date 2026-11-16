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
async function log(k, type, text) { await redis("LPUSH", k("log"), JSON.stringify({ type, text, at: Date.now() })); await redis("LTRIM", k("log"), 0, 299); }

/* ---------- ligas privadas: cada una tiene sus plantillas, mercado, precios, puntos y actividad ----------
   La liga original (la de antes de haber ligas) se queda con sus claves de siempre, sin prefijo. */
const LEGACY = "ALMAC";
const keysOf = code => name => (code === LEGACY ? "" : "lg:" + code + ":") + name;
async function allLeagues() { const h = await hgetall("leagues"); if (!h[LEGACY]) h[LEGACY] = { name: "Liga Almazora C", admin: null }; return h; }
async function myLeagues(name) {
  const u = await getJ("user:" + name); let l = (u && u.leagues) || null;
  if (!l) { l = (await redis("SISMEMBER", "users", name)) ? [LEGACY] : []; if (u) { u.leagues = l; await setJ("user:" + name, u); } }
  return l;
}
async function joinLeague(code, name) {
  const k = keysOf(code); await tick(k); await redis("SADD", k("users"), name);
  if (!(await getJ(k("team:") + name))) await setJ(k("team:") + name, await newTeam(k, name));
  const u = await getJ("user:" + name); u.leagues = Array.from(new Set((u.leagues || []).concat(code))); await setJ("user:" + name, u);
  await log(k, "join", `${name} se ha unido a la liga`);
}

/* ---------- precios ---------- */
// prices = { day, v:{id:valor}, prev:{id:valor de ayer}, h:{id:[últimos 30 valores]}, pub:[jornadas ya aplicadas] }
async function getPrices(k) {
  let pr = await getJ(k("prices"));
  if (!pr) { pr = { day: G.day(Date.now()), v: {}, prev: {}, h: {}, pub: [] };
    LIGA.players.forEach(p => { const v = G.baseValue(seasonPts(p.id)); pr.v[p.id] = v; pr.prev[p.id] = v; pr.h[p.id] = [v]; });
    pr.ver = G.PRICE_VER; await setJ(k("prices"), pr); }
  if (pr.ver !== G.PRICE_VER) {   // cambió la fórmula de precios: se recalcula todo con la nueva y se mantiene lo que subió o bajó cada uno
    LIGA.players.forEach(p => { const base = G.baseValue(seasonPts(p.id)), ratio = pr.h[p.id] && pr.h[p.id][0] ? (pr.v[p.id] || pr.h[p.id][0]) / pr.h[p.id][0] : 1;
      pr.v[p.id] = Math.max(300000, Math.round(base * ratio / 10000) * 10000); pr.prev[p.id] = base; pr.h[p.id] = [base, pr.v[p.id]].filter((x, i, a) => i === 0 || x !== a[0]); });
    pr.ver = G.PRICE_VER; await setJ(k("prices"), pr);
  }
  return pr;
}

/* ---------- cambio de día: se cierran las pujas, cambian los precios y sale mercado nuevo ---------- */
async function tick(k) {
  const today = G.day(Date.now()), pr = await getPrices(k);
  let market = await getJ(k("market"));
  if (market && pr.day === today && market.day === today) return;
  if (!(await redis("SET", k("lock:tick"), "1", "NX", "EX", 30))) return;
  try {
    const owner = (await redis("HGETALL", k("owner"))) || [], own = {}; for (let i = 0; i < owner.length; i += 2) own[owner[i]] = owner[i + 1];
    const demand = {}, unsold = {};
    // 1) cerrar subastas vencidas
    if (market) {
      const keep = [];
      for (const it of market.items) {
        if (it.ends > Date.now()) { keep.push(it); continue; }
        const bids = await hgetall(k("bids:") + it.pid); await redis("DEL", k("bids:") + it.pid);
        const list = Object.entries(bids).map(([u, b]) => ({ u, ...b })).sort((a, b) => b.amount - a.amount || a.at - b.at);
        demand[it.pid] = list.length;
        let done = false;
        for (const b of list) {
          if (b.u === it.seller) continue;
          const t = await getJ(k("team:") + b.u); if (!t || t.money < b.amount || t.squad.length >= G.MAX_SQUAD) continue;
          if (it.seller !== "LIGA") { const s = await getJ(k("team:") + it.seller);
            if (!s || !s.squad.includes(it.pid)) break;
            s.squad = s.squad.filter(x => x !== it.pid); s.money += b.amount; dropFromLineups(s, it.pid); await setJ(k("team:") + it.seller, s); }
          else if (own[it.pid]) break;
          t.money -= b.amount; t.squad.push(it.pid); await setJ(k("team:") + b.u, t); await redis("HSET", k("owner"), it.pid, b.u); own[it.pid] = b.u;
          await log(k, "market", `${t.name || b.u} ha comprado a ${PL[it.pid].n} a ${it.seller === "LIGA" ? "LIGA" : it.seller} por ${b.amount.toLocaleString("es-ES")}€` + (list.length > 1 ? ` (${list.length} pujas)` : ""));
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
        fresh.forEach(j => { const s = j.st && j.st[p.id]; if (G.mins(j, p.id) > 0) ch += Math.max(-0.15, Math.min(0.25, (G.points(posOf(p.id), j, p.id) - 3) * 0.04)); else ch -= 0.02; });
        const v0 = pr.v[p.id] || G.baseValue(0), v = Math.max(300000, Math.round(v0 * (1 + ch) / 1000) * 1000);
        pr.prev[p.id] = v0; pr.v[p.id] = v; pr.h[p.id] = (pr.h[p.id] || []).concat(v).slice(-30);
      });
      fresh.forEach(j => pr.pub.push(j.n)); pr.day = today; await setJ(k("prices"), pr);
    }
    // 3) mercado nuevo: jugadores libres al azar (más probables los que juegan)
    const ends = G.nextMidnight(Date.now()), inMk = new Set((market ? market.items : []).map(i => i.pid));
    const free = LIGA.players.filter(p => !own[p.id] && !inMk.has(p.id));
    const pick = []; const pool = free.map(p => ({ p, w: Math.random() * (1 + Math.min(4, (pr.v[p.id] || 0) / 4e6)) })).sort((a, b) => b.w - a.w);
    pool.slice(0, G.MARKET_SIZE).forEach(x => pick.push({ pid: x.p.id, seller: "LIGA", price: pr.v[x.p.id], ends }));
    market = { day: today, items: (market ? market.items : []).concat(pick) };
    await setJ(k("market"), market);
  } finally { await redis("DEL", k("lock:tick")); }
}
function dropFromLineups(t, pid) { Object.values(t.lineups || {}).forEach(l => { l.s = (l.s || []).map(x => x === pid ? null : x); if (l.c === pid) l.c = null; }); }

/* ---------- jornada en juego y cierre de alineaciones ---------- */
function currentJ(J) {
  let n = G.FIRST_J; while (J[n] && J[n].publicada) n++;
  const cal = LIGA.calendar[n] || [], kick = cal.map(m => G.madridTs(m[2])).filter(x => x > 0);
  return { n, lock: kick.length ? Math.min(...kick) : null, matches: cal };
}

/* ---------- equipo nuevo: 100 M y una plantilla aleatoria de unos 100 M ---------- */
async function newTeam(k, name) {
  const pr = await getPrices(k), owner = (await redis("HGETALL", k("owner"))) || [], taken = new Set(owner.filter((_, i) => i % 2 === 0));
  const mk = await getJ(k("market")); (mk ? mk.items : []).forEach(i => taken.add(i.pid));
  let best = null;
  for (let tries = 0; tries < 300; tries++) {
    const squad = []; let val = 0;
    for (const [pos, n] of Object.entries(G.START_SQUAD)) {
      const pool = LIGA.players.filter(p => posOf(p.id) === pos && !taken.has(p.id) && !squad.includes(p.id) && (pr.v[p.id] || 0) <= G.START_MAX).sort(() => Math.random() - 0.5);
      pool.slice(0, n).forEach(p => { squad.push(p.id); val += pr.v[p.id]; });
    }
    const err = Math.abs(val - G.START_VALUE);
    if (!best || err < best.err) best = { squad, err };
    if (err < 3e6) break;
  }
  for (const id of best.squad) await redis("HSET", k("owner"), id, name);
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
        const ok = await redis("SET", "user:" + name, JSON.stringify({ salt, hash: hash(pw, salt), admin: norm(process.env.ADMIN_USER) === name, leagues: [], created: Date.now() }), "NX");
        if (!ok) return send(409, { error: "Ese usuario ya existe. Prueba a entrar." });
        await redis("SADD", "allusers", name);
        if ((await redis("SCARD", "allusers")) === 1 && !(await redis("SCARD", "users"))) { const u = await getJ("user:" + name); u.admin = true; await setJ("user:" + name, u); }   // el primero de todos es el admin
      } else {
        let u = await getJ("user:" + name);
        if (!u) {   // cuenta de la primera versión (prefijo "fa:"): se pasa a la nueva con la misma contraseña
          const raw = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(["GET", "fa:user:" + name]) }).then(r => r.json()).catch(() => ({}));
          const old = raw && raw.result ? JSON.parse(raw.result) : null;
          if (old && hash(pw, old.salt) === old.hash) {
            u = { salt: old.salt, hash: old.hash, admin: norm(process.env.ADMIN_USER) === name, leagues: [], created: Date.now() };
            await redis("SET", "user:" + name, JSON.stringify(u), "NX"); await redis("SADD", "allusers", name);
          }
        }
        if (!u || hash(pw, u.salt) !== u.hash) return send(401, { error: "Usuario o contraseña incorrectos." });
      }
      return send(200, { token: await newSession(name) });
    }

    const me = await whoami(req);
    if (!me) return send(401, { error: "Sesión caducada. Vuelve a entrar." });
    const admin = me.admin || norm(process.env.ADMIN_USER) === me.name;
    const leagues = await allLeagues();
    let mineL = await myLeagues(me.name);

    // ---- crear liga / unirse con código ----
    if (a === "createLeague") {
      const lname = String(b.name || "").trim().slice(0, 30); if (lname.length < 2) return send(400, { error: "Ponle un nombre a la liga." });
      if (mineL.length >= 10) return send(400, { error: "Ya estás en 10 ligas." });
      let code; do { code = Array.from(crypto.randomBytes(6)).map(x => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join(""); } while (leagues[code]);
      await redis("HSET", "leagues", code, JSON.stringify({ name: lname, admin: me.name, created: Date.now() }));
      await joinLeague(code, me.name); return send(200, { ok: true, code });
    }
    if (a === "joinLeague") {
      const code = String(b.code || "").trim().toUpperCase(); if (!leagues[code]) return send(404, { error: "No hay ninguna liga con ese código." });
      if (mineL.includes(code)) return send(200, { ok: true, code });
      if (((await redis("SCARD", keysOf(code)("users"))) || 0) >= 20) return send(400, { error: "Esa liga ya tiene 20 equipos." });
      await joinLeague(code, me.name); return send(200, { ok: true, code });
    }

    const J = await allJornadas(), cur = currentJ(J), locked = cur.lock && Date.now() >= cur.lock;
    const lgList = mineL.filter(c => leagues[c]).map(c => ({ code: c, name: leagues[c].name, admin: leagues[c].admin }));
    const lg = mineL.includes(b.lg) ? b.lg : mineL[0];
    if (!lg) {   // todavía sin liga: solo puede crear una o unirse
      if (a === "state") return send(200, { me: me.name, admin, now: Date.now(), leagues: [], lg: null, current: { ...cur, locked: !!locked }, jornadas: {}, pos: POSO });
      if (!["importJornada", "unpublish", "setPos", "logout"].includes(a)) return send(400, { error: "Primero crea una liga o únete a una con su código." });
    }
    const k = keysOf(lg || LEGACY);
    let mine = null, myKey = null;
    if (lg) { await tick(k); myKey = k("team:") + me.name; mine = await getJ(myKey); if (!mine) { mine = await newTeam(k, me.name); await setJ(myKey, mine); } }

    if (a === "state") {
      const users = (await redis("SMEMBERS", k("users"))) || [];
      const [pr, market, points, logs, ownerArr] = await Promise.all([getPrices(k), getJ(k("market")), hgetall(k("points")), redis("LRANGE", k("log"), 0, 149), redis("HGETALL", k("owner"))]);
      const owner = {}; for (let i = 0; i < (ownerArr || []).length; i += 2) owner[ownerArr[i]] = ownerArr[i + 1];
      const teams = {};
      for (const u of users) { const t = u === me.name ? mine : await getJ(k("team:") + u); if (!t) continue;
        teams[u] = { name: t.name, squad: t.squad, lineups: t.lineups }; }   // el dinero de los demás no se enseña
      const myBids = {}; for (const it of (market ? market.items : [])) { const v = await redis("HGET", k("bids:") + it.pid, me.name); if (v) myBids[it.pid] = JSON.parse(v).amount; }
      const imported = {}; Object.values(J).filter(j => j.n >= G.FIRST_J).forEach(j => imported[j.n] = j);
      return send(200, { me: me.name, admin, now: Date.now(), leagues: lgList, lg, team: mine, teams, owner, prices: { v: pr.v, prev: pr.prev, h: pr.h }, market: market ? market.items : [],
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
      const market = await getJ(k("market")), it = (market ? market.items : []).find(i => i.pid === b.pid);
      if (!it || it.ends <= Date.now()) return send(400, { error: "Ese jugador ya no está en el mercado." });
      if (it.seller === me.name) return send(400, { error: "No puedes pujar por tu propio jugador." });
      if (b.amount == null || +b.amount === 0) { await redis("HDEL", k("bids:") + b.pid, me.name); return send(200, { ok: true }); }
      const amount = Math.round(+b.amount);
      if (!(amount >= it.price)) return send(400, { error: "La puja mínima es " + it.price.toLocaleString("es-ES") + " €." });
      let others = 0; for (const x of market.items) { if (x.pid === b.pid) continue; const v = await redis("HGET", k("bids:") + x.pid, me.name); if (v) others += JSON.parse(v).amount; }
      if (amount + others > mine.money) return send(400, { error: "Con tus otras pujas no te llega el saldo (" + mine.money.toLocaleString("es-ES") + " €)." });
      if (mine.squad.length >= G.MAX_SQUAD) return send(400, { error: "Tienes el máximo de " + G.MAX_SQUAD + " jugadores." });
      await redis("HSET", k("bids:") + b.pid, me.name, JSON.stringify({ amount, at: Date.now() })); return send(200, { ok: true });
    }
    if (a === "sell" || a === "list" || a === "unlist") {
      if (!mine.squad.includes(b.pid)) return send(400, { error: "Ese jugador no es tuyo." });
      const pr = await getPrices(k), v = pr.v[b.pid], market = (await getJ(k("market"))) || { day: G.day(Date.now()), items: [] };
      const inL = cur.lock && locked && G.lineupFor(mine, cur.n).s.includes(b.pid);
      if (a === "sell") {
        if (inL) return send(400, { error: "Está en tu alineación de una jornada en juego." });
        market.items = market.items.filter(i => !(i.pid === b.pid && i.seller === me.name)); await setJ(k("market"), market); await redis("DEL", k("bids:") + b.pid);
        mine.squad = mine.squad.filter(x => x !== b.pid); mine.money += v; dropFromLineups(mine, b.pid); await setJ(myKey, mine); await redis("HDEL", k("owner"), b.pid);
        await log(k, "market", `${mine.name || me.name} ha vendido a ${PL[b.pid].n} a LIGA por ${v.toLocaleString("es-ES")}€`);
      } else if (a === "list") {
        if (market.items.some(i => i.pid === b.pid)) return send(400, { error: "Ya está en el mercado." });
        const price = Math.max(v, Math.round(+b.price || v));
        market.items.push({ pid: b.pid, seller: me.name, price, ends: G.nextMidnight(Date.now()) }); await setJ(k("market"), market);
      } else { market.items = market.items.filter(i => !(i.pid === b.pid && i.seller === me.name)); await setJ(k("market"), market); await redis("DEL", k("bids:") + b.pid); }
      return send(200, { ok: true });
    }
    // ---- administrador ----
    if (a === "importJornada" || a === "unpublish" || a === "setPos") {
      if (!admin) return send(403, { error: "Solo el administrador puede hacer esto." });
      if (a === "setPos") { if (!PL[b.pid] || !G.GOL[b.pos]) return send(400, { error: "Datos no válidos." }); POSO[b.pid] = b.pos; await setJ("pos", POSO); return send(200, { ok: true }); }
      const n = parseInt((b.jornada || b).n, 10); if (!(n >= G.FIRST_J && n <= 40)) return send(400, { error: "Jornada no válida." });
      let Jn = null;
      if (a === "importJornada") {
        const jj = b.jornada; if (!jj || !Array.isArray(jj.matches) || typeof jj.st !== "object") return send(400, { error: "Faltan los partidos o las estadísticas." });
        Jn = { n, matches: jj.matches, st: jj.st, publicada: Date.now() }; await redis("HSET", "jornadas", String(n), JSON.stringify(Jn));
      } else await redis("HDEL", "jornadas", String(n));
      // los puntos y el dinero se reparten en todas las ligas
      for (const code of Object.keys(leagues)) {
        const kk = keysOf(code), users = (await redis("SMEMBERS", kk("users"))) || [], prevPts = (await hgetall(kk("points")))[n] || {};
        if (!Jn) {
          for (const u of users) { const t = await getJ(kk("team:") + u); if (!t) continue; t.money -= Math.max(0, prevPts[u] || 0) * G.PER_POINT; await setJ(kk("team:") + u, t); }
          await redis("HDEL", kk("points"), String(n)); continue;
        }
        const pts = {}, logs = [];
        for (const u of users) { const t = await getJ(kk("team:") + u); if (!t) continue;
          const r = G.teamPoints(t, Jn, posOf); pts[u] = r.total;
          t.money += (Math.max(0, r.total || 0) - Math.max(0, prevPts[u] || 0)) * G.PER_POINT; await setJ(kk("team:") + u, t);
          logs.push(r.total == null ? ["nopts", `En la jornada ${n}, ${t.name || u} no ha puntuado debido a alineación incompleta.`]
            : ["reward", `En la jornada ${n}, ${t.name || u} ha ganado ${(Math.max(0, r.total) * G.PER_POINT).toLocaleString("es-ES")}€ (${r.total} puntos)`]); }
        if (!users.length) continue;
        await redis("HSET", kk("points"), String(n), JSON.stringify(pts));
        for (const [t, x] of logs) await log(kk, t, x);
        await log(kk, "jornada", `Puntos de la jornada ${n} publicados.`);
      }
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
