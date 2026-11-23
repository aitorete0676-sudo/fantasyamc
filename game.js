// Reglas del fantasy. Lo usan la app (navegador) y el servidor (api/fantasy.js), así los puntos salen iguales en los dos.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GAME = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const R = {
    FIRST_J: 9,               // jornadas que se importan (estadísticas y precios) desde la 9
    POINTS_FROM: 10,          // los equipos ganan puntos y dinero desde la jornada 10
    START_MONEY: 100000000,    // dinero al entrar (100 M)
    START_VALUE: 100000000,    // valor aproximado de la plantilla inicial (100 M)
    START_MAX: 30000000,       // en la plantilla inicial no toca nadie que valga más de 30 M
    START_SQUAD: { POR: 2, DEF: 5, CEN: 5, DEL: 3 },   // plantilla aleatoria al entrar (15)
    MAX_SQUAD: 20,
    DAILY: 100000,             // recompensa diaria
    PER_POINT: 100000,         // € por punto en la jornada
    MARKET_SIZE: 12, MARKET_HM: "16:00", MARKET_DAYS: 2,
    SHIELD_DAYS: 7,            // días de blindaje: después de llegar a un equipo no se le puede pagar la cláusula
    CLAUSE_X: 2,               // subir la cláusula: cada € pagado la sube 2 €           // jugadores de la liga que salen cada día al mercado
    GOL: { POR: 10, DEF: 6, CEN: 5, DEL: 4 },
    CLEAN: { POR: 5, DEF: 4, CEN: 2, DEL: 1 },
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
  /* Puntos de un jugador en una jornada, apartado a apartado (como la ficha de LaLiga Fantasy).
     st = { t equipo, m minutos, ti titular, c capitán, g goles, gw goles de la victoria, ge goles del empate,
            gb goles saliendo del banquillo, ec goles encajados con él en el campo, y amarillas, r roja, pp goles en propia, so sustituido antes del descanso } */
  function rows(pos, s, res) {
    const m = s.m || 0, played = m > 0, win = res.gf > res.gc, draw = res.gf === res.gc, diff = res.gf - res.gc;
    const minPts = !played ? 0 : m >= 90 ? 4 : m >= 60 ? 3 : m >= 30 ? 2 : 1;
    const gk = pos === "POR" || pos === "DEF", ec = s.ec || 0;
    const L = [
      ["Minutos jugados", m, minPts],
      ["Titular", s.ti ? "Sí" : "No", s.ti ? 1 : 0],
      ["Goles", s.g || 0, (s.g || 0) * R.GOL[pos] + ((s.g || 0) >= 3 ? 3 : (s.g || 0) === 2 ? 2 : 0)],
      ["Gol de la victoria", s.gw || 0, 2 * (s.gw || 0)],
      ["Gol del empate", s.ge || 0, s.ge || 0],
      ["Gol saliendo del banquillo", s.gb || 0, s.gb ? 1 : 0],
      ["Portería a cero", played && m >= 60 && res.gc === 0 ? "Sí" : "No", played && m >= 60 && res.gc === 0 ? R.CLEAN[pos] : 0],
      ["Goles encajados en el campo", played ? ec : 0, !played || !gk ? 0 : pos === "POR" ? -ec : -Math.floor(ec / 2)],
      ["Resultado", !played ? "-" : win ? "Victoria" : draw ? "Empate" : "Derrota", !played ? 0 : win ? 2 : draw ? 1 : 0],
      ["Goleada (3 o más)", played && Math.abs(diff) >= 3 ? (diff > 0 ? "A favor" : "En contra") : "No", played && diff >= 3 ? 1 : 0],
      ["Capitán en el acta", s.c ? "Sí" : "No", s.c && played ? 1 : 0],
      ["Cambiado antes del descanso", s.so ? "Sí" : "No", s.so ? -1 : 0],
      ["Tarjetas amarillas", s.y || 0, (s.y || 0) >= 2 ? -3 : (s.y || 0) === 1 ? -1 : 0],
      ["Tarjeta roja directa", s.r ? 1 : 0, s.r && (s.y || 0) < 2 ? -4 : 0],
      ["Goles en propia puerta", s.pp || 0, -2 * (s.pp || 0)]
    ];
    return L;
  }
  function breakdown(pos, J, pid) {
    let s = J && J.st && J.st[pid]; if (!s) return null;
    if (Array.isArray(s)) { const [t, m, g, y, r, pp] = s; s = { t, m, g, y, r, pp }; }   // formato antiguo
    const res = teamResult(J, s.t) || { gf: 0, gc: 0 }, all = rows(pos, s, res);
    return { ...s, res, rows: all, items: all.filter(x => x[2]).map(x => [x[0], x[2]]), total: all.reduce((a, x) => a + x[2], 0) };
  }
  const points = (pos, J, pid) => { const b = breakdown(pos, J, pid); return b ? b.total : 0; };

  /* Acta (JSON de datos-liga/actas) → estadísticas de cada jugador. Lo usan el script de datos y el Admin. */
  function parseActa(d, tid) {
    const [hg, ag] = String(d.resultado).split("-").map(Number), th = tid(d.local), ta = tid(d.visitante);
    if (th == null || ta == null) throw new Error("Equipo desconocido: " + (th == null ? d.local : d.visitante));
    const [dd, mo, yy] = d.fecha.split("/"), out = {};
    // goles reales de cada equipo con su minuto ("(gol)" de más = en propia puerta y cuenta para el rival)
    const timeline = [], ownBy = {};
    [[d.local, hg, d.visitante], [d.visitante, ag, d.local]].forEach(([tm, score, other]) => {
      const mine = (d.goles || []).filter(g => g.equipo === tm); let excess = Math.max(0, mine.length - score);
      mine.forEach(g => { if (excess && /gol/.test(g.nota || "")) { excess--; ownBy[g.id_jugador] = (ownBy[g.id_jugador] || 0) + 1; timeline.push({ min: g.minuto || 0, team: other, pid: null }); }
        else timeline.push({ min: g.minuto || 0, team: tm, pid: g.id_jugador }); });
    });
    timeline.sort((a, b) => a.min - b.min);
    // gol de la victoria: el que pone al ganador por delante para siempre; gol del empate: el último que iguala en un empate
    const decisive = {}; let sh = 0, sa = 0, lastLead = null, lastEq = null;
    timeline.forEach((g, i) => { const before = sh - sa; if (g.team === d.local) sh++; else sa++; const after = sh - sa;
      if (after === 0) lastEq = i; if (Math.sign(after) !== 0 && Math.sign(before) !== Math.sign(after)) lastLead = i; });
    if (hg !== ag && lastLead != null && timeline[lastLead].pid) decisive[lastLead] = "gw";
    if (hg === ag && hg > 0 && lastEq != null && timeline[lastEq].pid) decisive[lastEq] = "ge";
    for (const al of d.alineaciones || []) {
      const tm = al.equipo, t = tid(tm), st = {};
      const reg = (x, tit) => st[x.id_jugador] = { t, m: tit ? 90 : 0, ti: tit ? 1 : 0, c: x.capitan ? 1 : 0, g: 0, gw: 0, ge: 0, gb: 0, ec: 0, y: 0, r: 0, pp: 0, so: 0, on: tit ? 0 : null, off: tit ? 90 : null };
      (al.titulares || []).forEach(x => reg(x, true)); (al.suplentes || []).forEach(x => reg(x, false));
      (d.sustituciones || []).filter(s => s.equipo === tm).forEach(s => { const o = st[s.sale.id_jugador], i = st[s.entra.id_jugador];
        if (o && o.on != null) { o.off = Math.min(o.off, s.minuto); if (o.ti && s.minuto <= 45) o.so = 1; }
        if (i) { i.on = s.minuto; i.off = 90; } });
      (d.tarjetas || []).filter(c => c.equipo === tm).forEach(c => { const s = st[c.id_jugador]; if (!s) return;
        if (c.tipo === "amarilla") s.y++; else if (/amarilla/.test(c.tipo)) s.y = 2; else s.r = 1;
        if ((s.y >= 2 || s.r) && s.on != null) { s.off = Math.min(s.off, c.minuto); s.so = 0; } });
      Object.values(st).forEach(s => { s.m = s.on == null ? 0 : Math.max(s.on === s.off ? 1 : 0, s.off - s.on); });
      timeline.forEach((g, i) => { if (g.team === tm) { const s = g.pid && st[g.pid]; if (!s) return; s.g++; if (decisive[i] === "gw") s.gw++; if (decisive[i] === "ge") s.ge++; if (!s.ti) s.gb++; }
        else Object.values(st).forEach(s => { if (s.on != null && g.min > s.on && g.min <= s.off) s.ec++; }); });
      Object.entries(ownBy).forEach(([pid, n]) => { if (st[pid]) st[pid].pp = n; });
      Object.entries(st).forEach(([pid, s]) => { if (!(s.m > 0 || s.g || s.y || s.r || s.pp)) return;
        const o = { t: s.t, m: s.m }; ["ti", "c", "g", "gw", "ge", "gb", "ec", "y", "r", "pp", "so"].forEach(k => { if (s[k]) o[k] = k === "y" ? Math.min(2, s[k]) : s[k]; }); out[pid] = o; });
    }
    return { n: d.jornada, match: [th, ta, hg, ag, `${yy}-${mo}-${dd}T${d.hora}`], st: out };
  }

  // Precio inicial según los puntos de la temporada (escala tipo LaLiga Fantasy): 0 pts → 0,5 M, la media (~23) → ~10 M,
  // 60 pts (top 10 %) → ~42 M, 100 pts (el mejor) → ~100 M
  const PRICE_VER = 2;
  const baseValue = pts => { const x = Math.max(0, pts); return Math.max(500000, Math.round((500000 + 239000 * x + 7560 * x * x) / 10000) * 10000); };
  // Minutos de un jugador en una jornada (vale para el formato antiguo y el nuevo)
  const mins = (J, pid) => { const s = J && J.st && J.st[pid]; return !s ? 0 : Array.isArray(s) ? s[1] || 0 : s.m || 0; };
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
  // Hora "HH:MM" de Madrid de un instante, y siguiente vez que en Madrid sean las "HH:MM" (cierre de mercado de cada liga)
  const madridHM = t => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t)).replace(/^24/, "00");
  function nextClose(t, hm) {
    hm = /^\d\d:\d\d$/.test(hm || "") ? hm : "00:00";
    let c = madridTs(day(t) + "T" + hm); if (c > t) return c;
    return madridTs(day(c + 24 * 3600e3) + "T" + hm);
  }
  // Alineación vigente para la jornada n: la última guardada en esa jornada o antes
  function lineupFor(team, n) {
    const L = (team && team.lineups) || {}; let k = null;
    Object.keys(L).map(Number).filter(x => x <= n).forEach(x => { if (k == null || x > k) k = x; });
    const l = k != null ? L[k] : null;
    return l ? { f: R.FORMS[l.f] ? l.f : "4-4-2", s: (l.s || []).slice(0, 11), c: l.c || null } : { f: "4-4-2", s: Array(11).fill(null), c: null };
  }
  // Día de la semana en Madrid (0 domingo … 5 viernes)
  const wday = t => new Date(day(t) + "T12:00:00Z").getUTCDay();
  // Clausulazos cerrados todo el viernes (de jueves 24:00 a viernes 24:00, hora de Madrid)
  const clauseBlocked = t => wday(t) === 5;
  // Cierre de alineaciones: viernes a las 21:00 de la semana de la jornada (o antes, si algún partido empieza antes)
  function jornadaLock(kicks) {
    if (!kicks.length) return null; const first = Math.min(...kicks);
    let t = first; while (wday(t) !== 5) t -= 24 * 3600e3;
    return Math.min(first, madridTs(day(t) + "T21:00"));
  }
  // Puntos de un equipo en una jornada. null = no puntúa: alineación incompleta o saldo negativo al cierre (why = "inc" | "neg").
  // Si hay foto del cierre (team.snap[n]) se usa esa: la plantilla que tenía a las 21:00 del viernes.
  function teamPoints(team, J, posOf) {
    const sn = team && team.snap && team.snap[J.n];
    const l = sn ? { f: sn.l.f, s: (sn.l.s || []).slice(0, 11), c: sn.l.c || null } : lineupFor(team, J.n), ids = l.s.filter(Boolean);
    if (ids.length < 11) return { total: null, l, why: "inc" };
    if (sn && sn.neg) return { total: null, l, why: "neg" };
    let total = 0; ids.forEach(id => { total += points(posOf(id), J, id) * (id === l.c ? 2 : 1); });
    return { total, l };
  }
  return Object.assign(R, { wday, clauseBlocked, jornadaLock, madridHM, nextClose, PRICE_VER, mins, parseActa, rows, madridTs, teamResult, breakdown, points, baseValue, day, nextMidnight, lineupFor, teamPoints });
});
