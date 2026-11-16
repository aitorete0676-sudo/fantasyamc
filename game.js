// Reglas del fantasy. Lo usan la app (navegador) y el servidor (api/fantasy.js), así los puntos salen iguales en los dos.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GAME = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const R = {
    FIRST_J: 9,               // el fantasy puntúa desde la jornada 9
    START_MONEY: 100000000,    // dinero al entrar (100 M)
    START_VALUE: 100000000,    // valor aproximado de la plantilla inicial (100 M)
    START_SQUAD: { POR: 2, DEF: 5, CEN: 5, DEL: 3 },   // plantilla aleatoria al entrar (15)
    MAX_SQUAD: 20,
    DAILY: 100000,             // recompensa diaria
    PER_POINT: 100000,         // € por punto en la jornada
    MARKET_SIZE: 12,           // jugadores de la liga que salen cada día al mercado
    GOL: { POR: 10, DEF: 6, CEN: 5, DEL: 4 },
    CLEAN: { POR: 4, DEF: 3, CEN: 1, DEL: 0 },
    FORMS: { "4-4-2": [4, 4, 2], "4-3-3": [4, 3, 3], "3-5-2": [3, 5, 2], "3-4-3": [3, 4, 3], "4-5-1": [4, 5, 1], "5-3-2": [5, 3, 2], "5-4-1": [5, 4, 1] }
  };
  // Resultado de un equipo en una jornada: { gf, gc, rival, local }
  function teamResult(J, t) {
    for (const [h, a, hg, ag] of J.matches || []) {
      if (h === t) return { gf: hg, gc: ag, rival: a, local: true };
      if (a === t) return { gf: ag, gc: hg, rival: h, local: false };
    }
    return null;
  }
  // Desglose de puntos de un jugador en una jornada. st = [equipo, minutos, goles, amarillas, roja, propia]
  function breakdown(pos, J, pid) {
    const s = J && J.st && J.st[pid]; if (!s) return null;
    const [t, m, g, y, r, pp] = s, res = teamResult(J, t) || { gf: 0, gc: 0 }, out = [];
    const add = (txt, v) => { if (v) out.push([txt, v]); };
    if (m > 0) {
      add(m >= 60 ? "Juega " + m + "'" : "Juega " + m + "' (menos de 60)", m >= 60 ? 2 : 1);
      add(g === 1 ? "Gol" : g + " goles", g * R.GOL[pos]);
      if (m >= 60 && res.gc === 0) add("Portería a cero", R.CLEAN[pos]);
      if (m >= 60 && (pos === "POR" || pos === "DEF")) add(res.gc + " goles encajados", -Math.floor(res.gc / 2));
      if (res.gf > res.gc) add("Victoria", 2); else if (res.gf === res.gc) add("Empate", 1);
    }
    add("Gol en propia puerta", -2 * (pp || 0));
    if (y === 1) add("Amarilla", -1);
    if (y >= 2) add("Doble amarilla", -3); else if (r) add("Roja directa", -3);
    return { m, g, y, r, pp, t, res, items: out, total: out.reduce((a, x) => a + x[1], 0) };
  }
  const points = (pos, J, pid) => { const b = breakdown(pos, J, pid); return b ? b.total : 0; };
  // Precio inicial según los puntos de la temporada: ~1,5 M sin puntos, ~8 M a 14 puntos (la media), ~40 M el mejor
const baseValue = pts => Math.max(500000, Math.round((1500000 + pts * 450000 + Math.max(0, pts - 20) * 300000) / 10000) * 10000);
  // Día y medianoche en hora de Madrid
  const day = t => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  function nextMidnight(t) {
    const d = day(t); let lo = t, hi = t + 26 * 3600e3;
    while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (day(mid) === d) lo = mid; else hi = mid; }
    return Math.round(hi / 60000) * 60000;
  }
  // "2026-11-22T15:00" en hora de Madrid → milisegundos
  function madridTs(str) {
    const guess = Date.parse(str + ":00Z"); if (isNaN(guess)) return null;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const g = k => +parts.find(p => p.type === k).value, asMadrid = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    return guess - (asMadrid - guess);
  }
  // Alineación vigente para la jornada n: la última guardada en esa jornada o antes
  function lineupFor(team, n) {
    const L = (team && team.lineups) || {}; let k = null;
    Object.keys(L).map(Number).filter(x => x <= n).forEach(x => { if (k == null || x > k) k = x; });
    const l = k != null ? L[k] : null;
    return l ? { f: R.FORMS[l.f] ? l.f : "4-4-2", s: (l.s || []).slice(0, 11), c: l.c || null } : { f: "4-4-2", s: Array(11).fill(null), c: null };
  }
  // Puntos de un equipo en una jornada. null = no puntúa (alineación incompleta)
  function teamPoints(team, J, posOf) {
    const l = lineupFor(team, J.n), ids = l.s.filter(Boolean);
    if (ids.length < 11) return { total: null, l };
    let total = 0; ids.forEach(id => { total += points(posOf(id), J, id) * (id === l.c ? 2 : 1); });
    return { total, l };
  }
  return Object.assign(R, { madridTs, teamResult, breakdown, points, baseValue, day, nextMidnight, lineupFor, teamPoints });
});
