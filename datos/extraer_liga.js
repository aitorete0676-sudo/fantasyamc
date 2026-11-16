// Genera ../liga.json (equipos, jugadores, J1–J8 y calendario) a partir de las actas, con las mismas reglas que la app.
// Uso: node datos/extraer_liga.js RUTA/datos-liga
const fs = require("fs"), path = require("path"), G = require("../game.js");
const SRC = process.argv[2] || "datos-liga", OUT = path.join(__dirname, "..", "liga.json");
const cal = JSON.parse(fs.readFileSync(path.join(SRC, "jornadas.json"), "utf8"));
const short = t => { let s = t.replace(/\b(C\.\s?D\.|C\.\s?F\.|F\.\s?C\.|S\.A\.D\.|C\.\s?E\.|U\.\s?D\.)/gi, "").replace(/FÚTBOL CLUB/i, "").replace(/'/g, "").replace(/de Castellón/, "").replace(/\s+/g, " ").trim().replace(/^\.|\.$/g, "").trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()) : s; };
const TEAMS = [], TIDX = {}; const tid = n => { if (!(n in TIDX)) { TIDX[n] = TEAMS.length; TEAMS.push({ name: n, short: short(n) }); } return TIDX[n]; };
const NICK = { "SERGIO DOMENECH ESTEVE": "Chechu", "GIUSEPPE DI BENEDETTO": "Adriano", "GENNIE ALBERTO MORENO COLLAZOS": "Gennie" };
const POS_FIX = { "MARC CONDE MARTÍ": "POR", "MANEL LLOP HERRANDO": "POR", "DANIEL MUÑOZ TRUJILLO": "DEF", "ARIEL CABANES CLARAMONTE": "DEF", "SERGI CATALA MEZQUITA": "DEF",
  "ALEJANDRO MARTINEZ VENTURA": "DEF", "IKER MEDIAVILLA FERRER": "DEF", "SERGIO DOMENECH ESTEVE": "DEF", "TOMAS BALAGUE GARCIA": "DEF", "ASIER ALVARADO BARTOLL": "DEF",
  "UNAI ARNAU MORENO": "DEF", "CESAR LUIS BLACIO CASTRO": "DEF", "VICTOR DE LA TORRE ABRIL": "CEN", "RAMON HERRANDO BORILLO": "CEN", "ARNAU BADAL PRADES": "CEN",
  "MARC ESCOBAR AGOST": "CEN", "GIUSEPPE DI BENEDETTO": "CEN", "JUAN DEVESA CERVERA": "CEN", "AITOR JIMENEZ VILLENA": "CEN", "ALEX FERNANDEZ FABREGAT": "CEN",
  "GENNIE ALBERTO MORENO COLLAZOS": "CEN", "ALEJANDRO GRIGORE": "DEL", "CARLOS MOLINER CANO": "DEL", "RAMÓN TERCERO VAZQUEZ": "DEL" };
const title = s => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
const disp = f => NICK[f] || (w => w.length >= 3 ? w[0] + " " + w[1] : w.join(" "))(title(f).split(" "));
const P = {}, J = {};
for (const f of fs.readdirSync(path.join(SRC, "actas")).filter(f => f.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(SRC, "actas", f), "utf8"));
  const r = G.parseActa(d, tid), JJ = J[r.n] = J[r.n] || { n: r.n, matches: [], st: {} };
  JJ.matches.push(r.match); Object.assign(JJ.st, r.st);
  for (const al of d.alineaciones) for (const x of (al.titulares || []).concat(al.suplentes || [])) {
    const p = P[x.id_jugador] = P[x.id_jugador] || { id: x.id_jugador, full: x.jugador, dors: {}, por: 0, apps: 0, g: 0 };
    p.t = tid(al.equipo); p.dors[x.dorsal] = (p.dors[x.dorsal] || 0) + 1; if (x.portero) p.por++;
    const s = r.st[x.id_jugador]; if (s && s.m > 0) { p.apps++; p.g += s.g || 0; }
  }
}
const players = Object.values(P).map(p => { const dor = Object.entries(p.dors).sort((a, b) => b[1] - a[1])[0][0];
  const pos = POS_FIX[p.full] || (p.por ? "POR" : p.g >= 3 || (p.apps && p.g / p.apps >= 0.4) || dor === "9" ? "DEL" : ["2", "3", "4", "5", "12", "15"].includes(dor) ? "DEF" : ["7", "11"].includes(dor) && p.g >= 1 ? "DEL" : "CEN");
  return { id: p.id, n: disp(p.full), full: title(p.full), t: p.t, pos, d: +dor || 0 }; }).sort((a, b) => TEAMS[a.t].short.localeCompare(TEAMS[b.t].short) || a.d - b.d);
const calendar = {};
for (const j of cal.jornadas) for (const m of j.partidos) { if (m.jugado) continue; const [dd, mo, yy] = m.fecha.split("/");
  (calendar[j.jornada] = calendar[j.jornada] || []).push([tid(m.local), tid(m.visitante), `${yy}-${mo}-${dd}T${m.hora || "12:00"}`, m.codacta]); }
Object.values(J).forEach(x => x.matches.sort((a, b) => a[4] < b[4] ? -1 : 1));
fs.writeFileSync(OUT, JSON.stringify({ generado: "actas FFCV J1-J" + Math.max(...Object.keys(J)), teams: TEAMS, players, jornadas: J, calendar }));
console.log("equipos", TEAMS.length, "jugadores", players.length, "bytes", fs.statSync(OUT).size);
