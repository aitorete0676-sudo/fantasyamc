// Almazora C Fantasy · servidor en Vercel. Guarda cuentas, equipos y actas en Upstash Redis
// (Vercel > Storage > Upstash for Redis). No hace falta tocar nada aquí.
const crypto = require("crypto");

// Vale cualquier prefijo que ponga Vercel al conectar la base de datos (KV_, STORAGE_, UPSTASH_REDIS_...)
const envKey = suf => process.env["KV" + suf] ? "KV" + suf : Object.keys(process.env).find(k => k.endsWith(suf) && !k.includes("READ_ONLY"));
const URL_ = process.env[envKey("_REST_API_URL")] || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env[envKey("_REST_API_TOKEN")] || process.env.UPSTASH_REDIS_REST_TOKEN;

// Todas las claves llevan "fa:" delante, así puede compartir base de datos con AlmaBet ("ab:").
const P = "fa:";
async function redis(...cmd) {
  if (cmd.length > 1) cmd[1] = P + cmd[1];
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const getJ = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
const setJ = (k, v) => redis("SET", k, JSON.stringify(v));
const norm = u => String(u || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]/g, "");
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
async function hgetall(k) { const h = (await redis("HGETALL", k)) || []; const o = {}; for (let i = 0; i < h.length; i += 2) o[h[i]] = JSON.parse(h[i + 1]); return o; }

async function newSession(name) {
  const t = crypto.randomBytes(24).toString("hex");
  await redis("SET", "sess:" + t, name, "EX", 60 * 60 * 24 * 365);
  return t;
}
async function whoami(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const name = await redis("GET", "sess:" + t);
  if (!name) return null;
  const u = await getJ("user:" + name);
  return u ? { name, ...u } : null;
}
// Equipo: nombre, operaciones de mercado y alineaciones por jornada
function cleanTeam(t) {
  t = t && typeof t === "object" ? t : {};
  const ops = (Array.isArray(t.ops) ? t.ops : []).slice(-2000).filter(o => o && ["buy", "sell", "daily"].includes(o.t))
    .map(o => ({ t: o.t, pid: o.pid ? String(o.pid).slice(0, 20) : undefined, price: +o.price || 0, at: +o.at || Date.now() }));
  const lineups = {}; Object.entries(t.lineups && typeof t.lineups === "object" ? t.lineups : {}).slice(-60).forEach(([n, l]) => {
    if (!l) return; lineups[+n] = { f: String(l.f || "4-4-2").slice(0, 8), s: (Array.isArray(l.s) ? l.s : []).slice(0, 11).map(x => x ? String(x).slice(0, 20) : null), c: l.c ? String(l.c).slice(0, 20) : null }; });
  return { name: String(t.name || "").slice(0, 28), ops, lineups };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => res.status(code).json(obj);
  if (!URL_ || !TOKEN) return send(500, { error: "Falta conectar la base de datos: en Vercel ve a Storage > Upstash for Redis > Connect y vuelve a desplegar." });
  try {
    let b = req.body || {};
    if (typeof b === "string") b = JSON.parse(b || "{}");
    const a = b.action;

    if (a === "register" || a === "login") {
      const name = norm(b.username), pw = String(b.password || "");
      if (name.length < 2 || name.length > 20 || pw.length < 6) return send(400, { error: "El usuario necesita 2 a 20 letras y la contraseña 6 caracteres o más." });
      if (a === "register") {
        const salt = crypto.randomBytes(16).toString("hex");
        const ok = await redis("SET", "user:" + name, JSON.stringify({ salt, hash: hash(pw, salt), admin: false, created: Date.now() }), "NX");
        if (!ok) return send(409, { error: "Ese usuario ya existe. Prueba a entrar." });
        // El primero que se registra es el administrador (o el que diga ADMIN_USER en Vercel)
        const first = (await redis("SADD", "users", name)) && (await redis("SCARD", "users")) === 1;
        if (first || norm(process.env.ADMIN_USER) === name) { const u = await getJ("user:" + name); u.admin = true; await setJ("user:" + name, u); }
      } else {
        const u = await getJ("user:" + name);
        if (!u || hash(pw, u.salt) !== u.hash) return send(401, { error: "Usuario o contraseña incorrectos." });
      }
      return send(200, { token: await newSession(name) });
    }

    const me = await whoami(req);
    if (!me) return send(401, { error: "Sesión caducada. Vuelve a entrar." });
    const admin = me.admin || norm(process.env.ADMIN_USER) === me.name;

    if (a === "me") return send(200, { username: me.name, admin });
    if (a === "state") {
      const [jornadas, teams, plantilla] = await Promise.all([hgetall("jornadas"), hgetall("teams"), getJ("plantilla")]);
      return send(200, { jornadas, teams, plantilla });
    }
    if (a === "saveTeam") { await redis("HSET", "teams", me.name, JSON.stringify(cleanTeam(b.team))); return send(200, { ok: true }); }
    if (a === "saveJornada" || a === "savePlantilla") {
      if (!admin) return send(403, { error: "Solo el administrador puede cambiar actas y plantilla." });
      if (a === "saveJornada") { const j = b.jornada || {}; const n = parseInt(j.n, 10); if (!(n >= 1 && n <= 60)) return send(400, { error: "Jornada no válida." });
        await redis("HSET", "jornadas", "j" + n, JSON.stringify(j)); }
      else await setJ("plantilla", { extra: Array.isArray((b.plantilla || {}).extra) ? b.plantilla.extra.slice(0, 60) : [] });
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
