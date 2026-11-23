// Almazora C Fantasy · servidor en Vercel (Upstash Redis). Cuentas, dinero, plantillas, pujas, precios y jornadas.
// Todo lo importante (dinero, quién tiene a quién, pujas) se decide aquí, no en el móvil de cada uno.
const crypto = require("crypto");
const G = require("../game.js");
const LIGA = require("../liga.json");
const FF = require("../ffcv.js");

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
async function allLeagues() { const h = await hgetall("leagues"); if (!h[LEGACY]) h[LEGACY] = { name: "Liga Almazora C", admin: null, hm: "00:00" }; return h; }
// Hora de cierre del mercado de cada liga: la hora a la que se creó (la original, a las 00:00)
const hmOf = () => G.MARKET_HM;   // todas las ligas: el mercado se actualiza a las 16:00 (los valores cambian a las 00:00)
async function leagueK(code) { const k = keysOf(code); k.hm = hmOf((await allLeagues())[code]); return k; }
async function myLeagues(name) {
  const u = await getJ("user:" + name); let l = (u && u.leagues) || null;
  if (!l) { l = (await redis("SISMEMBER", "users", name)) ? [LEGACY] : []; if (u) { u.leagues = l; await setJ("user:" + name, u); } }
  return l;
}
async function joinLeague(code, name) {
  const k = await leagueK(code); await tick(k); await redis("SADD", k("users"), name);
  if (!(await getJ(k("team:") + name))) await setJ(k("team:") + name, await newTeam(k, name));
  const u = await getJ("user:" + name); u.leagues = Array.from(new Set((u.leagues || []).concat(code))); await setJ("user:" + name, u);
  await log(k, "join", `${name} se ha unido a la liga`);
}

/* ---------- precios ---------- */
// prices = { day, v:{id:valor}, prev:{id:valor de ayer}, h:{id:[últimos 30 valores]}, pub:[jornadas ya aplicadas] }
async function getPrices() {   // precios únicos para todas las ligas
  let pr = await getJ("prices");
  if (!pr) { pr = { day: G.day(Date.now()), v: {}, prev: {}, h: {}, pub: [] };
    LIGA.players.forEach(p => { const v = G.baseValue(seasonPts(p.id)); pr.v[p.id] = v; pr.prev[p.id] = v; pr.h[p.id] = [v]; });
    pr.ver = G.PRICE_VER; await setJ("prices", pr); }
  if (pr.ver !== G.PRICE_VER) {   // cambió la fórmula de precios: se recalcula todo con la nueva y se mantiene lo que subió o bajó cada uno
    LIGA.players.forEach(p => { const base = G.baseValue(seasonPts(p.id)), ratio = pr.h[p.id] && pr.h[p.id][0] ? (pr.v[p.id] || pr.h[p.id][0]) / pr.h[p.id][0] : 1;
      pr.v[p.id] = Math.max(300000, Math.round(base * ratio / 10000) * 10000); pr.prev[p.id] = base; pr.h[p.id] = [base, pr.v[p.id]].filter((x, i, a) => i === 0 || x !== a[0]); });
    pr.ver = G.PRICE_VER; await setJ("prices", pr);
  }
  return pr;
}

/* ---------- precios del día (iguales en todas las ligas) ----------
   Demanda = pujas recibidas en todas las ligas (hash "dem"); "uns" = puesto a la venta por alguien y sin pujas. */
async function priceTick() {
  const today = G.day(Date.now()), pr = await getPrices();
  if (pr.day === today) return pr;
  if (!(await redis("SET", "lock:prices", "1", "NX", "EX", 30))) return pr;
  try {
    const [dem, uns, J] = await Promise.all([hgetall("dem"), hgetall("uns"), allJornadas()]);
    const fresh = Object.values(J).filter(j => j.n >= G.FIRST_J && j.publicada && !pr.pub.includes(j.n));
    LIGA.players.forEach(p => {
      let ch = Math.min(0.05, 0.01 * (+dem[p.id] || 0)) - Math.min(0.03, 0.01 * (+uns[p.id] || 0));
      fresh.forEach(j => { if (G.mins(j, p.id) > 0) ch += Math.max(-0.05, Math.min(0.08, (G.points(posOf(p.id), j, p.id) - 3) * 0.01)); else ch -= 0.01; });
      const v0 = pr.v[p.id] || G.baseValue(0), v = Math.max(300000, Math.round(v0 * (1 + ch) / 1000) * 1000);
      pr.prev[p.id] = v0; pr.v[p.id] = v; pr.h[p.id] = (pr.h[p.id] || []).concat(v).slice(-30);
    });
    fresh.forEach(j => pr.pub.push(j.n)); pr.day = today; await setJ("prices", pr);
    await redis("DEL", "dem"); await redis("DEL", "uns");
  } finally { await redis("DEL", "lock:prices"); }
  return pr;
}

/* ---------- cambio de día en una liga: se cierran las pujas y sale mercado nuevo ---------- */
async function tick(k) {
  const today = G.day(Date.now()), pr = await priceTick();
  let market = await getJ(k("market"));
  const next = market ? (market.next || (market.day === today ? G.nextMidnight(Date.now()) : 0)) : 0;   // los mercados de antes no tenían "next"
  const daily = !market || next <= Date.now(), due = market && market.items.some(it => it.seller !== "LIGA" && it.ends <= Date.now());
  if (!daily && market.items.some(it => it.seller === "LIGA" && it.ends > next)) {   // jugadores de LIGA: 24 h (de 16:00 a 16:00)
    market.items.forEach(it => { if (it.seller === "LIGA" && it.ends > next) it.ends = next; }); await setJ(k("market"), market); }
  if (!daily && !due) return;   // a las 16:00 cambia el mercado; los jugadores de los mánagers se van justo a las 48 h
  if (!(await redis("SET", k("lock:tick"), "1", "NX", "EX", 30))) return;
  try {
    const owner = (await redis("HGETALL", k("owner"))) || [], own = {}; for (let i = 0; i < owner.length; i += 2) own[owner[i]] = owner[i + 1];
    // 1) cerrar subastas vencidas
    if (market) {
      const keep = [];
      for (const it of market.items) {
        if (it.ends > Date.now()) { keep.push(it); continue; }
        const bids = await hgetall(k("bids:") + it.pid); await redis("DEL", k("bids:") + it.pid);
        const list = Object.entries(bids).map(([u, b]) => ({ u, ...b })).sort((a, b) => b.amount - a.amount || a.at - b.at);
        if (list.length) await redis("HINCRBY", "dem", it.pid, list.length);
        let done = false;
        for (const b of list) {
          if (b.u === it.seller) continue;
          const t = await getJ(k("team:") + b.u); if (!t || canSpend(t, pr, it.seller === "LIGA") < b.amount || t.squad.length >= G.MAX_SQUAD) continue;
          if (it.seller !== "LIGA") { const s = await getJ(k("team:") + it.seller);
            if (!s || !s.squad.includes(it.pid)) break;
            s.squad = s.squad.filter(x => x !== it.pid); s.money += b.amount; dropFromLineups(s, it.pid); lose(s, it.pid); await setJ(k("team:") + it.seller, s); }
          else if (own[it.pid]) break;
          t.money -= b.amount; t.squad.push(it.pid); gain(t, it.pid, Math.max(b.amount, pr.v[it.pid] || 0)); await setJ(k("team:") + b.u, t); await redis("HSET", k("owner"), it.pid, b.u); own[it.pid] = b.u;
          await log(k, "market", `${t.name || b.u} ha comprado a ${PL[it.pid].n} a ${it.seller === "LIGA" ? "LIGA" : it.seller} por ${b.amount.toLocaleString("es-ES")}€` + (list.length > 1 ? ` (${list.length} pujas)` : ""));
          done = true; break;
        }
        if (!done && it.seller !== "LIGA") await redis("HINCRBY", "uns", it.pid, 1);   // sin comprador: sale del mercado y sigue en su equipo
      }
      market.items = keep;
      if (!daily) { await setJ(k("market"), market); return; }
      // LIGA hace su oferta diaria (a las 16:00) por cada jugador que los mánagers tienen a la venta
      for (const it of market.items) if (it.seller !== "LIGA") it.offer = ligaOffer(pr.v[it.pid] || it.price);
    }
    // 2) mercado nuevo: jugadores libres al azar (más probables los que valen más)
    const next = G.nextClose(Date.now(), k.hm), ends = next, inMk = new Set((market ? market.items : []).map(i => i.pid));
    const free = LIGA.players.filter(p => !own[p.id] && !inMk.has(p.id));
    const pick = []; const pool = free.map(p => ({ p, w: Math.random() * (1 + Math.min(4, (pr.v[p.id] || 0) / 4e6)) })).sort((a, b) => b.w - a.w);
    pool.slice(0, G.MARKET_SIZE).forEach(x => pick.push({ pid: x.p.id, seller: "LIGA", price: pr.v[x.p.id], ends }));
    market = { day: today, next, items: (market ? market.items : []).concat(pick) };
    await setJ(k("market"), market);
  } finally { await redis("DEL", k("lock:tick")); }
}
// Oferta diaria de LIGA por un jugador puesto a la venta: ronda su valor (entre −7 % y +7 %)
const ligaOffer = v => Math.max(300000, Math.round(v * (0.93 + Math.random() * 0.14) / 10000) * 10000);
// Cláusula: nunca por debajo del valor. "since" = cuándo llegó al equipo (blindaje de SHIELD_DAYS días)
// Lo que se puede gastar: el saldo; en fichajes de LIGA, además, deuda hasta el 20 % del valor del equipo
const canSpend = (t, pr, liga) => t.money + (liga ? Math.floor(G.DEBT * (t.squad || []).reduce((s, id) => s + (pr.v[id] || 0), 0)) : 0);
const clauseOf = (t, pid, pr) => Math.max((t.cl && t.cl[pid]) || 0, pr.v[pid] || 0);
function gain(t, pid, amount) { t.cl = t.cl || {}; t.since = t.since || {}; t.cl[pid] = Math.max(amount, 0); t.since[pid] = Date.now(); }
function lose(t, pid) { if (t.cl) delete t.cl[pid]; if (t.since) delete t.since[pid]; }
// Foto de cada equipo al cierre de la jornada n (viernes 21:00): alineación y si tenía saldo negativo. Puntúa con eso.
async function snapLeague(kk, n, force) {
  if (!force && !(await redis("SET", kk("snap:") + n, "1", "NX"))) return;
  const users = (await redis("SMEMBERS", kk("users"))) || [];
  for (const u of users) { const t = await getJ(kk("team:") + u); if (!t) continue; t.snap = t.snap || {};
    if (t.snap[n]) continue; const l = G.lineupFor(t, n); t.snap[n] = { l: { f: l.f, s: l.s.map(id => id && t.squad.includes(id) ? id : null), c: t.squad.includes(l.c) ? l.c : null }, neg: t.money < 0, at: Date.now() };
    await setJ(kk("team:") + u, t); }
}
function dropFromLineups(t, pid) { Object.values(t.lineups || {}).forEach(l => { l.s = (l.s || []).map(x => x === pid ? null : x); if (l.c === pid) l.c = null; }); }

/* ---------- jornada en juego y cierre de alineaciones ---------- */
function currentJ(J) {
  let n = G.FIRST_J; while (J[n] && J[n].publicada) n++;
  const cal = LIGA.calendar[n] || [], kick = cal.map(m => G.madridTs(m[2])).filter(x => x > 0);
  return { n, lock: G.jornadaLock(kick), matches: cal };
}

/* ---------- equipo nuevo: 100 M y una plantilla aleatoria de unos 100 M ---------- */
async function newTeam(k, name) {
  const pr = await getPrices(), owner = (await redis("HGETALL", k("owner"))) || [], taken = new Set(owner.filter((_, i) => i % 2 === 0));
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
  const t = { name: "", money: G.START_MONEY, squad: best.squad, lineups: {}, daily: "", joined: Date.now(), v3: 1 };
  best.squad.forEach(id => gain(t, id, Math.round((pr.v[id] || 0) * G.CLAUSE_START))); return t;
}

/* ---------- publicar una jornada: puntos y dinero en todas las ligas (Jn = null la quita) ---------- */
async function payJornada(n, Jn, leagues) {
      for (const code of Object.keys(leagues)) {
        const kk = keysOf(code), users = (await redis("SMEMBERS", kk("users"))) || [], prevPts = (await hgetall(kk("points")))[n] || {};
        if (!Jn || n < G.POINTS_FROM) {   // sin jornada o anterior a POINTS_FROM: se quita lo pagado
          if (!(await redis("HEXISTS", kk("points"), String(n)))) continue;
          for (const u of users) { const t = await getJ(kk("team:") + u); if (!t) continue; t.money -= Math.max(0, prevPts[u] || 0) * G.PER_POINT; await setJ(kk("team:") + u, t); }
          await redis("HDEL", kk("points"), String(n)); continue;
        }
        await snapLeague(kk, n, true);
        const pts = {}, logs = [];
        for (const u of users) { const t = await getJ(kk("team:") + u); if (!t) continue;
          const r = G.teamPoints(t, Jn, posOf); pts[u] = r.total;
          t.money += (Math.max(0, r.total || 0) - Math.max(0, prevPts[u] || 0)) * G.PER_POINT; await setJ(kk("team:") + u, t);
          logs.push(r.total == null ? ["nopts", `En la jornada ${n}, ${t.name || u} no ha puntuado debido a ${r.why === "neg" ? "saldo negativo" : "alineación incompleta"}.`]
            : ["reward", `En la jornada ${n}, ${t.name || u} ha ganado ${(Math.max(0, r.total) * G.PER_POINT).toLocaleString("es-ES")}€ (${r.total} puntos)`]); }
        if (!users.length) continue;
        await redis("HSET", kk("points"), String(n), JSON.stringify(pts));
        for (const [t, x] of logs) await log(kk, t, x);
        await log(kk, "jornada", `Puntos de la jornada ${n} publicados.`);
      }
}
// Jornadas automáticas: cuando se juega una jornada, se bajan las actas de elbalondelacomunitat.es y se publica sola.
// Se mira como mucho cada 2 h, solo de viernes 21:00 a lunes 12:00 (hora de Madrid), más el cron del lunes a las 12:00.
// Si falta algún partido, 6 h después del último se publica con los jugados; si el que faltaba se juega más tarde, se vuelve a publicar.
function finde(t) {   // viernes 21:00 → lunes 12:00, hora de Madrid
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(t));
  const wd = f.find(x => x.type === "weekday").value, h = +f.find(x => x.type === "hour").value;
  return (wd === "Fri" && h >= 21) || wd === "Sat" || wd === "Sun" || (wd === "Mon" && h < 12);
}
// Correcciones a mano de las actas de la federación: por jornada, gol de un jugador que en realidad es de otro (ids).
const FIXES = { 9: [{ gol: "38058", a: "9796573" }] };   // J9 Almazora C: gol de Sergio Domenech → Carlos Moliner
const fxOf = n => JSON.stringify(FIXES[n] || []);
function fixActa(d, n) { for (const f of FIXES[n] || []) { const g = d.goles.find(x => x.id_jugador === f.gol); if (g) g.id_jugador = f.a; } return d; }
async function autoJornada(leagues, force, cron) {
  if (force) await redis("SET", "auto:chk", "1", "EX", 60);
  else { if (!cron && !finde(Date.now())) return { msg: "Fuera del horario de búsqueda." };
    if (!(await redis("SET", "auto:chk", "1", "NX", "EX", 7200))) return { msg: "Ya se ha mirado hace poco." }; }
  const imp = await hgetall("jornadas"), out = [];
  for (const k of Object.keys(imp)) if (+k < G.POINTS_FROM) await payJornada(+k, null, leagues);   // J9 no da puntos a los equipos
  let n = G.FIRST_J; while (imp[n]) n++;
  const todo = Object.values(imp).filter(J => J.n < n && (J.faltan > 0 || (J.auto && (J.fx || "[]") !== fxOf(J.n)))).map(J => J.n).concat([n]);
  const idx = {}; LIGA.teams.forEach((t, i) => idx[t.name.trim().toLowerCase()] = i);
  const tid = x => idx[String(x).trim().toLowerCase()];
  for (const jn of todo) {
    const ps = await FF.jornada(jn); if (!ps.length) { out.push(`J${jn}: sin partidos`); continue; }
    const played = ps.filter(p => p.jugado), faltan = ps.length - played.length, last = Math.max(...ps.map(p => p.ts || 0));
    if (!played.length) { out.push(`J${jn}: aún no se ha jugado`); continue; }
    if (imp[jn] && imp[jn].faltan === faltan && (imp[jn].fx || "[]") === fxOf(jn)) { out.push(`J${jn}: sin cambios`); continue; }
    if (faltan && Date.now() < last + 6 * 3600e3) { out.push(`J${jn}: faltan ${faltan} partidos por jugar`); continue; }
    const actas = await Promise.all(played.map(p => FF.actaHtml(p.cod).then(h => FF.parseActaHtml(h, p.cod, p.local, p.visitante)).then(d => d && fixActa(d, jn)).catch(() => null)));
    const matches = [], st = {}; let bad = 0;
    for (const d of actas) { if (!d || tid(d.local) == null || tid(d.visitante) == null) { bad++; continue; }
      const r = G.parseActa(d, tid); matches.push(r.match); Object.entries(r.st).forEach(([pid, x]) => { if (PL[pid]) st[pid] = x; }); }
    if (bad) { out.push(`J${jn}: no se han podido leer ${bad} actas`); continue; }
    matches.sort((a, b) => a[4] < b[4] ? -1 : 1);
    const Jn = { n: jn, matches, st, publicada: Date.now(), auto: 1, faltan: faltan + bad, fx: fxOf(jn) };
    await redis("HSET", "jornadas", String(jn), JSON.stringify(Jn)); await payJornada(jn, Jn, leagues);
    out.push(`J${jn} publicada (${matches.length} partidos${faltan ? ", faltan " + faltan : ""})`);
  }
  return { msg: out.join(" · ") };
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

    if (req.query && req.query.cron) { const r = await autoJornada(await allLeagues(), false, true).catch(e => ({ msg: e.message })); return send(200, r); }
    const me = await whoami(req);
    if (!me) return send(401, { error: "Sesión caducada. Vuelve a entrar." });
    const admin = me.admin || norm(process.env.ADMIN_USER) === me.name;
    const leagues = await allLeagues();
    if (await redis("SET", "mig:clref", "1", "NX")) {   // una vez: se devuelve lo pagado por subir cláusulas y se deshace la subida
      const pr = await getPrices(), today = G.day(Date.now());
      const valAt = (id, at) => { const h = pr.h[id] || [], ago = Math.round((Date.parse(today) - Date.parse(G.day(at))) / 864e5); return h[Math.max(0, h.length - 1 - ago)] || pr.v[id] || 0; };
      for (const code of Object.keys(leagues)) { const kk = keysOf(code), users = (await redis("SMEMBERS", kk("users"))) || [], teams = {};
        for (const u of users) { const t = await getJ(kk("team:") + u); if (t) teams[u] = t; }
        const byName = n => Object.keys(teams).find(u => (teams[u].name || u) === n) || (teams[n] ? n : null);
        const logs = ((await redis("LRANGE", kk("log"), 0, 299)) || []).map(x => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch (e) { return null; } }).filter(Boolean).reverse();
        const last = {}, base = {}, ch = new Set(), num = x => +String(x).replace(/\./g, "");
        const pidOf = (t, n) => (t && (t.squad || []).find(i => PL[i] && PL[i].n === n)) || Object.keys(PL).find(i => PL[i].n === n);
        for (const L of logs) { const tx = L.text || "";
          const g = /^(.*) ha comprado a (.*) a .* por ([\d.]+)€/.exec(tx) || /^¡Clausulazo! (.*) ha pagado la cláusula de (.*) a .*: ([\d.]+)€$/.exec(tx) || /^(.*) ha fichado a (.*) de .* por ([\d.]+)€ \(oferta aceptada\)$/.exec(tx);
          if (g) { const u = byName(g[1]), id = u && pidOf(teams[u], g[2]); if (id) { base[u + ":" + id] = num(g[3]); delete last[u + ":" + id]; } continue; }
          const m = /^(.*) ha subido la cláusula de (.*) a ([\d.]+)€$/.exec(tx); if (!m) continue;
          const u = byName(m[1]); if (!u) continue; const t = teams[u], to = +m[3].replace(/\./g, "");
          const id = (t.squad || []).find(i => PL[i] && PL[i].n === m[2]) || Object.keys(PL).find(i => PL[i].n === m[2]); if (!id) continue;
          const key = u + ":" + id, since = (t.since || {})[id] || t.joined || 0, before = last[key] || Math.max(base[key] || valAt(id, since), valAt(id, L.at));
          const paid = Math.max(0, Math.round((to - before) / G.CLAUSE_X / 1000) * 1000); last[key] = to;
          t.money += paid; if (t.cl && t.cl[id]) t.cl[id] = Math.max(0, t.cl[id] - paid * G.CLAUSE_X); ch.add(u);
          await log(kk, "market", `Se han devuelto ${paid.toLocaleString("es-ES")}€ a ${t.name || u} por subir la cláusula de ${PL[id].n}`); }
        for (const u of ch) await setJ(kk("team:") + u, teams[u]); }
    }
    if (await redis("SET", "mig:cl53", "1", "NX")) {   // una vez: cláusula de los jugadores del reparto inicial = valor × 5/3
      const pr = await getPrices();
      for (const code of Object.keys(leagues)) { const kk = keysOf(code);
        for (const u of (await redis("SMEMBERS", kk("users"))) || []) { const t = await getJ(kk("team:") + u); if (!t) continue; let ch = 0;
          for (const id of t.squad || []) { const sn = (t.since || {})[id]; if (sn && t.joined && Math.abs(sn - t.joined) < 60e3) { t.cl = t.cl || {}; t.cl[id] = Math.round((pr.v[id] || 0) * G.CLAUSE_START); ch = 1; } }
          if (ch) await setJ(kk("team:") + u, t); } }
    }
    let mineL = await myLeagues(me.name);

    // ---- crear liga / unirse con código ----
    if (a === "createLeague") {
      const lname = String(b.name || "").trim().slice(0, 30); if (lname.length < 2) return send(400, { error: "Ponle un nombre a la liga." });
      if (mineL.length >= 10) return send(400, { error: "Ya estás en 10 ligas." });
      let code; do { code = Array.from(crypto.randomBytes(6)).map(x => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join(""); } while (leagues[code]);
      const created = Date.now(); await redis("HSET", "leagues", code, JSON.stringify({ name: lname, admin: me.name, created, hm: G.madridHM(created) }));
      await joinLeague(code, me.name); return send(200, { ok: true, code });
    }
    if (a === "joinLeague") {
      const code = String(b.code || "").trim().toUpperCase(); if (!leagues[code]) return send(404, { error: "No hay ninguna liga con ese código." });
      if (mineL.includes(code)) return send(200, { ok: true, code });
      if (((await redis("SCARD", keysOf(code)("users"))) || 0) >= 20) return send(400, { error: "Esa liga ya tiene 20 equipos." });
      await joinLeague(code, me.name); return send(200, { ok: true, code });
    }

    if (a === "autoJornada") { if (!admin) return send(403, { error: "Solo el administrador puede hacer esto." }); return send(200, await autoJornada(leagues, true)); }
    let J = await allJornadas(), cur = currentJ(J), locked = cur.lock && Date.now() >= cur.lock;
    if (a === "state" && locked) { const r = await autoJornada(leagues, false).catch(() => null);   // la jornada ya empezó: ¿hay actas nuevas?
      if (r && / publicada/.test(r.msg)) { J = await allJornadas(); cur = currentJ(J); locked = cur.lock && Date.now() >= cur.lock; } }
    const lgList = mineL.filter(c => leagues[c]).map(c => ({ code: c, name: leagues[c].name, admin: leagues[c].admin, hm: hmOf(leagues[c]) }));
    const lg = mineL.includes(b.lg) ? b.lg : mineL[0];
    if (!lg) {   // todavía sin liga: solo puede crear una o unirse
      if (a === "state") return send(200, { me: me.name, admin, now: Date.now(), leagues: [], lg: null, current: { ...cur, locked: !!locked }, jornadas: {}, pos: POSO });
      if (!["importJornada", "unpublish", "setPos", "logout"].includes(a)) return send(400, { error: "Primero crea una liga o únete a una con su código." });
    }
    const k = keysOf(lg || LEGACY); k.hm = hmOf(leagues[lg || LEGACY]);
    let mine = null, myKey = null;
    if (lg) { await tick(k); if (locked) await snapLeague(k, cur.n); myKey = k("team:") + me.name; mine = await getJ(myKey); if (!mine) { mine = await newTeam(k, me.name); await setJ(myKey, mine); }
      if (!mine.v3) {   // plantillas repartidas con los precios antiguos: si no rondan los 100 M se reparten otra vez (una sola vez); se mantienen dinero y nombre
        const pr = await getPrices(), val = mine.squad.reduce((a, id) => a + (pr.v[id] || 0), 0);
        if (Math.abs(val - G.START_VALUE) > 10e6) {
          for (const id of mine.squad) await redis("HDEL", k("owner"), id);
          const mk = await getJ(k("market")); if (mk) { mk.items = mk.items.filter(i => i.seller !== me.name); await setJ(k("market"), mk); }
          const t = await newTeam(k, me.name); mine.squad = t.squad; mine.lineups = {}; mine.cl = t.cl; mine.since = t.since;
          await log(k, "info", `A ${mine.name || me.name} se le ha cambiado la plantilla para que ronde los 100 M con los precios nuevos (antes valía ${Math.round(val / 1e6)} M).`);
        }
        mine.v3 = 1; await setJ(myKey, mine);
      } }

    if (a === "state") {
      const users = (await redis("SMEMBERS", k("users"))) || [];
      const [pr, market, points, logs, ownerArr] = await Promise.all([getPrices(), getJ(k("market")), hgetall(k("points")), redis("LRANGE", k("log"), 0, 149), redis("HGETALL", k("owner"))]);
      const owner = {}; for (let i = 0; i < (ownerArr || []).length; i += 2) owner[ownerArr[i]] = ownerArr[i + 1];
      const teams = {};
      for (const u of users) { const t = u === me.name ? mine : await getJ(k("team:") + u); if (!t) continue;
        teams[u] = { name: t.name, squad: t.squad, lineups: t.lineups, cl: Object.fromEntries(t.squad.map(id => [id, clauseOf(t, id, pr)])), since: t.since || {}, joined: t.joined || 0, snap: t.snap || {} }; }   // el dinero de los demás no se enseña
      const myBids = {}, nb = {}; for (const it of (market ? market.items : [])) { const all = await hgetall(k("bids:") + it.pid); nb[it.pid] = Object.keys(all).length; if (all[me.name]) myBids[it.pid] = all[me.name].amount; }
      const offersIn = [], offersOut = []; for (const [f, o] of Object.entries(await hgetall(k("offers")))) {
        if (owner[o.pid] !== o.to) { await redis("HDEL", k("offers"), f); continue; }
        if (o.to === me.name) offersIn.push(o); else if (o.from === me.name) offersOut.push(o); }
      const imported = {}; Object.values(J).filter(j => j.n >= G.FIRST_J).forEach(j => imported[j.n] = j);
      return send(200, { me: me.name, admin, now: Date.now(), leagues: lgList, lg, close: k.hm, team: mine, teams, owner, prices: { v: pr.v, prev: pr.prev, h: pr.h }, market: market ? market.items.map(i => ({ ...i, nb: nb[i.pid] || 0 })) : [],
        myBids, offersIn, offersOut, points, log: (logs || []).map(x => JSON.parse(x)), jornadas: imported, current: { ...cur, locked: !!locked }, pos: POSO });
    }
    if (a === "fav") {   // favoritos (en cada liga los suyos)
      if (!PL[b.pid]) return send(400, { error: "Jugador desconocido." });
      const f = new Set(mine.favs || []); f.has(b.pid) ? f.delete(b.pid) : f.add(b.pid); mine.favs = [...f].slice(-100); await setJ(myKey, mine); return send(200, { ok: true });
    }
    if (a === "raiseClause") {   // pagas X y la cláusula sube 2X
      if (!mine.squad.includes(b.pid)) return send(400, { error: "Ese jugador no es tuyo." });
      const x = Math.round(+b.amount || 0); if (!(x >= 100000)) return send(400, { error: "Sube al menos 100.000 €." });
      if (x > mine.money) return send(400, { error: "No tienes tanto saldo." });
      const pr = await getPrices(), c = clauseOf(mine, b.pid, pr); mine.money -= x; mine.cl = mine.cl || {}; mine.cl[b.pid] = c + G.CLAUSE_X * x; await setJ(myKey, mine);
      await log(k, "market", `${mine.name || me.name} ha subido la cláusula de ${PL[b.pid].n} a ${mine.cl[b.pid].toLocaleString("es-ES")}€`);
      return send(200, { ok: true, clause: mine.cl[b.pid] });
    }
    if (a === "payClause") {   // clausulazo: se paga la cláusula al dueño y el jugador pasa a tu equipo al momento
      const ow = await redis("HGET", k("owner"), b.pid); if (!ow || ow === me.name) return send(400, { error: "Ese jugador no tiene dueño rival." });
      if (G.clauseBlocked(Date.now())) return send(400, { error: "Los viernes no se pueden pagar cláusulas (de jueves a las 24:00 a viernes a las 24:00)." });
      const t = await getJ(k("team:") + ow); if (!t || !t.squad.includes(b.pid)) return send(400, { error: "Ese jugador ya no está en ese equipo." });
      const until = G.shieldUntil(t, b.pid);
      if (Date.now() < until) return send(400, { error: "Está blindado hasta el " + new Date(until).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) + "." });
      if (mine.squad.length >= G.MAX_SQUAD) return send(400, { error: "Tienes el máximo de " + G.MAX_SQUAD + " jugadores." });
      const pr = await getPrices(), c = clauseOf(t, b.pid, pr); if (mine.money < c) return send(400, { error: "Te faltan " + (c - mine.money).toLocaleString("es-ES") + " € para la cláusula." });
      t.squad = t.squad.filter(x => x !== b.pid); t.money += c; dropFromLineups(t, b.pid); lose(t, b.pid); await setJ(k("team:") + ow, t);
      mine.money -= c; mine.squad.push(b.pid); gain(mine, b.pid, c); await setJ(myKey, mine); await redis("HSET", k("owner"), b.pid, me.name);
      const mk = await getJ(k("market")); if (mk && mk.items.some(i => i.pid === b.pid)) { mk.items = mk.items.filter(i => i.pid !== b.pid); await setJ(k("market"), mk); await redis("DEL", k("bids:") + b.pid); }
      await log(k, "market", `¡Clausulazo! ${mine.name || me.name} ha pagado la cláusula de ${PL[b.pid].n} a ${t.name || ow}: ${c.toLocaleString("es-ES")}€`);
      return send(200, { ok: true, amount: c });
    }
    // ---- ofertas entre mánagers: ofreces dinero al dueño; si acepta, el jugador pasa a tu equipo al momento ----
    if (a === "mgrOffer" || a === "mgrCancel" || a === "mgrAccept" || a === "mgrReject") {
      const pid = String(b.pid || ""); if (!PL[pid]) return send(400, { error: "Jugador desconocido." });
      const ow = await redis("HGET", k("owner"), pid);
      if (a === "mgrOffer") {
        if (!ow || ow === me.name) return send(400, { error: "Ese jugador no tiene dueño rival." });
        const pr = await getPrices(), v = pr.v[pid] || 0, x = Math.round(+b.amount || 0);
        if (!(x >= v)) return send(400, { error: "La oferta no puede ser menor que su valor (" + v.toLocaleString("es-ES") + " €)." });
        if (x > mine.money) return send(400, { error: "No tienes tanto saldo." });
        await redis("HSET", k("offers"), pid + "|" + me.name, JSON.stringify({ pid, from: me.name, to: ow, amount: x, at: Date.now() }));
        await log(k, "market", `${mine.name || me.name} ha hecho una oferta por ${PL[pid].n} a ${(await getJ(k("team:") + ow) || {}).name || ow}`);
        return send(200, { ok: true });
      }
      if (a === "mgrCancel") { await redis("HDEL", k("offers"), pid + "|" + me.name); return send(200, { ok: true }); }
      const from = String(b.from || ""), raw = await redis("HGET", k("offers"), pid + "|" + from); const o = raw ? JSON.parse(raw) : null;
      if (!o || ow !== me.name) { if (o) await redis("HDEL", k("offers"), pid + "|" + from); return send(400, { error: "Esa oferta ya no está activa." }); }
      const buyerKey = k("team:") + from, buyer = await getJ(buyerKey);
      if (a === "mgrReject") { await redis("HDEL", k("offers"), pid + "|" + from); await log(k, "market", `${mine.name || me.name} ha rechazado la oferta de ${(buyer && buyer.name) || from} por ${PL[pid].n}`); return send(200, { ok: true }); }
      if (locked) return send(400, { error: "Durante la jornada no se pueden cerrar traspasos." });
      if (!buyer || buyer.money < o.amount) return send(400, { error: "El comprador ya no tiene saldo para pagar esa oferta." });
      if (buyer.squad.length >= G.MAX_SQUAD) return send(400, { error: "El comprador ya tiene el máximo de jugadores." });
      if (!mine.squad.includes(pid)) return send(400, { error: "Ese jugador ya no es tuyo." });
      mine.squad = mine.squad.filter(x => x !== pid); mine.money += o.amount; dropFromLineups(mine, pid); lose(mine, pid); await setJ(myKey, mine);
      buyer.money -= o.amount; buyer.squad.push(pid); gain(buyer, pid, o.amount); await setJ(buyerKey, buyer); await redis("HSET", k("owner"), pid, from);
      const mk = await getJ(k("market")); if (mk && mk.items.some(i => i.pid === pid)) { mk.items = mk.items.filter(i => i.pid !== pid); await setJ(k("market"), mk); await redis("DEL", k("bids:") + pid); }
      const all = await hgetall(k("offers")); for (const f of Object.keys(all)) if (f.startsWith(pid + "|")) await redis("HDEL", k("offers"), f);
      await log(k, "market", `${(buyer.name) || from} ha fichado a ${PL[pid].n} de ${mine.name || me.name} por ${o.amount.toLocaleString("es-ES")}€ (oferta aceptada)`);
      return send(200, { ok: true, amount: o.amount });
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
      const minBid = Math.max(it.price, (await getPrices()).v[b.pid] || 0);   // nunca por debajo del valor del jugador
      if (!(amount >= minBid)) return send(400, { error: "No puedes pujar por menos de su valor: " + minBid.toLocaleString("es-ES") + " €." });
      let others = 0; for (const x of market.items) { if (x.pid === b.pid) continue; const v = await redis("HGET", k("bids:") + x.pid, me.name); if (v) others += JSON.parse(v).amount; }
      const lim = canSpend(mine, await getPrices(), it.seller === "LIGA");
      if (amount + others > lim) return send(400, { error: it.seller === "LIGA" ? "La cantidad pujada sobrepasa tu endeudamiento permitido (20% valor de tu equipo)." : "Con tus otras pujas no te llega el saldo (" + mine.money.toLocaleString("es-ES") + " €)." });
      if (mine.squad.length >= G.MAX_SQUAD) return send(400, { error: "Tienes el máximo de " + G.MAX_SQUAD + " jugadores." });
      await redis("HSET", k("bids:") + b.pid, me.name, JSON.stringify({ amount, at: Date.now() })); return send(200, { ok: true });
    }
    if (a === "acceptOffer" || a === "rejectOffer" || a === "list" || a === "unlist") {
      if (!mine.squad.includes(b.pid)) return send(400, { error: "Ese jugador no es tuyo." });
      const pr = await getPrices(), v = pr.v[b.pid], market = (await getJ(k("market"))) || { day: G.day(Date.now()), items: [] };
      const inL = cur.lock && locked && G.lineupFor(mine, cur.n).s.includes(b.pid), it = market.items.find(i => i.pid === b.pid && i.seller === me.name);
      if (a === "rejectOffer") {   // rechazas la oferta de LIGA: mañana te hará otra
        if (!it || !it.offer) return send(400, { error: "No tienes ninguna oferta de LIGA por este jugador." });
        it.offer = 0; await setJ(k("market"), market); return send(200, { ok: true });
      }
      if (a === "acceptOffer") {
        if (!it || !it.offer) return send(400, { error: "No tienes ninguna oferta de LIGA por este jugador." });
        if (inL) return send(400, { error: "Está en tu alineación de una jornada en juego." });
        market.items = market.items.filter(i => i !== it); await setJ(k("market"), market); await redis("DEL", k("bids:") + b.pid);
        mine.squad = mine.squad.filter(x => x !== b.pid); mine.money += it.offer; dropFromLineups(mine, b.pid); lose(mine, b.pid); await setJ(myKey, mine); await redis("HDEL", k("owner"), b.pid);
        await log(k, "market", `${mine.name || me.name} ha vendido a ${PL[b.pid].n} a LIGA por ${it.offer.toLocaleString("es-ES")}€`);
        return send(200, { ok: true, amount: it.offer });
      } else if (a === "list") {
        if (it || market.items.some(i => i.pid === b.pid)) return send(400, { error: "Ya está en el mercado." });
        const price = Math.max(v, Math.round(+b.price || v));
        market.items.push({ pid: b.pid, seller: me.name, price, ends: Date.now() + G.MARKET_DAYS * 86400e3, offer: 0 }); await setJ(k("market"), market);   // 48 h exactas desde que lo pones; LIGA ofertará a las 16:00
      } else { market.items = market.items.filter(i => i !== it); await setJ(k("market"), market); await redis("DEL", k("bids:") + b.pid); }
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
      await payJornada(n, Jn, leagues);
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
