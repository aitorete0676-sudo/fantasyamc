// Descarga de jornadas de elbalondelacomunitat.es (datos públicos de la FFCV) para publicarlas solas.
// results?round=N da los partidos; cada acta es HTML y se convierte al mismo JSON que las actas de datos-liga.
const BASE = "https://www.elbalondelacomunitat.es", COMP = "905431620", GRUPO = "905431622";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; fantasy-amc/1.0)", Accept: "text/html,application/json" };

async function get(url, json) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { headers: UA, signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status + " en " + url); return json ? r.json() : r.text(); }
  finally { clearTimeout(to); }
}
const results = n => get(`${BASE}/api/ffcv/results?idGroup=${GRUPO}&round=${n}`, true);
const actaHtml = cod => get(`${BASE}/acta/${cod}?competicion=${COMP}&grupo=${GRUPO}`);

const ent = s => String(s).replace(/<!--.*?-->/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const txt = s => ent(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const minOf = li => { const m = li.match(/<span[^>]*>\s*(\d+)\s*(?:<!--.*?-->)?\s*(?:&#x27;|')/); return m ? +m[1] : 0; };
const teamOf = li => { const m = li.match(/title="([^"]*)"/); return m ? ent(m[1]).trim() : ""; };
const pidsOf = s => [...s.matchAll(/\/jugador\/(\d+)\//g)].map(m => m[1]);
const lis = s => [...s.matchAll(/<li[\s>][\s\S]*?<\/li>/g)].map(m => m[0]);
// Trozo de la sección cuyo <h2> es "titulo"
function section(h, titulo) {
  const i = h.search(new RegExp("<h2[^>]*>\\s*" + titulo + "\\s*</h2>")); if (i < 0) return "";
  const j = h.indexOf("</section>", i); return h.slice(i, j < 0 ? undefined : j);
}

// HTML del acta → { jornada, fecha, hora, local, visitante, resultado, alineaciones, goles, tarjetas, sustituciones }
function parseActaHtml(html, cod, local, visitante) {
  const h = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  const jm = h.match(/Jornada\s*(?:<!--\s*-->)?\s*(\d+)/), dm = h.match(/<span[^>]*>(\d{2})-(\d{2})-(\d{4})<\/span>\s*<span[^>]*>(\d{1,2}:\d{2})<\/span>/);
  const rm = h.match(/<span[^>]*>\s*(\d+)\s*(?:<!--\s*-->)?\s*[–-]\s*(?:<!--\s*-->)?\s*(\d+)\s*<\/span>/);
  if (!rm) return null;   // sin resultado: no se ha jugado
  const d = { codacta: cod, jornada: jm ? +jm[1] : null, fecha: dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : "", hora: dm ? dm[4] : "12:00", local, visitante, resultado: rm[1] + "-" + rm[2],
    alineaciones: [], goles: [], tarjetas: [], sustituciones: [] };
  // alineaciones: un bloque por equipo con <h3>Nombre</h3> … Titulares <ul> … Suplentes <ul>
  for (const m of h.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3|<h2|<\/main>)/g)) {
    const equipo = txt(m[1]), body = m[2]; if (!/Titulares/.test(body)) continue;
    const part = (from, to) => { const i = body.indexOf(from); if (i < 0) return []; const j = to ? body.indexOf(to, i) : -1; const ul = body.slice(i, j < 0 ? undefined : j).match(/<ul[\s\S]*?<\/ul>/); return ul ? lis(ul[0]) : []; };
    const pl = li => { const id = pidsOf(li)[0], a = li.match(/<a[^>]*>([\s\S]*?)<\/a>/), dor = li.match(/<span[^>]*>\s*(\d+)\s*<\/span>/);
      return id && { dorsal: dor ? dor[1] : "", jugador: a ? txt(a[1]) : "", id_jugador: id, portero: />\s*GK\s*</.test(li), capitan: /title="Capit/.test(li), otros: [] }; };
    const fm = body.match(/<span[^>]*>\s*(\d(?:-\d)+)\s*<\/span>/);
    d.alineaciones.push({ equipo: [local, visitante].find(x => x.toLowerCase() === equipo.toLowerCase()) || equipo, formacion: fm ? fm[1] : "",
      titulares: part("Titulares", "Suplentes").map(pl).filter(Boolean), suplentes: part("Suplentes").map(pl).filter(Boolean) });
  }
  const fixTeam = t => [local, visitante].find(x => x.toLowerCase() === t.toLowerCase()) || t;
  for (const li of lis(section(h, "Goles"))) { const id = pidsOf(li)[0]; if (!id) continue; const nota = /\(\s*(?:<!--\s*-->)?\s*gol/.test(li) ? "(gol)" : "";
    d.goles.push({ minuto: minOf(li), equipo: fixTeam(teamOf(li)), id_jugador: id, nota }); }
  for (const li of lis(section(h, "Tarjetas"))) { const id = pidsOf(li)[0]; if (!id) continue; const lab = (li.match(/aria-label="([^"]*)"/) || [])[1] || "";
    const tipo = /amarilla/i.test(lab) && /(roja|2|doble|segunda)/i.test(lab) ? "2a amarilla+roja" : /roja/i.test(lab) ? "roja" : "amarilla";
    d.tarjetas.push({ minuto: minOf(li), equipo: fixTeam(teamOf(li)), tipo, id_jugador: id }); }
  for (const li of lis(section(h, "Sustituciones"))) { const ids = pidsOf(li); if (ids.length < 2) continue;
    const down = li.indexOf("↓"), up = li.indexOf("↑"), [first, second] = ids;   // ↓ sale, ↑ entra
    const sale = down >= 0 && up >= 0 && up < down ? second : first, entra = sale === first ? second : first;
    d.sustituciones.push({ minuto: minOf(li), equipo: fixTeam(teamOf(li)), sale: { id_jugador: sale }, entra: { id_jugador: entra } }); }
  return d;
}

// Partidos de la jornada n: [{ cod, local, visitante, jugado, ts }]
async function jornada(n) {
  const r = await results(n);
  return (r.partidos || []).map(p => { const [dd, mo, yy] = String(p.fecha || "").split("/");
    return { cod: p.codacta, local: String(p.Nombre_equipo_local || "").trim(), visitante: String(p.Nombre_equipo_visitante || "").trim(),
      jugado: String(p.estado) === "1" && p.Goles_casa !== "" && p.Goles_visitante !== "", ts: yy ? Date.parse(`${yy}-${mo}-${dd}T${p.hora || "12:00"}:00+01:00`) : 0 }; });
}
module.exports = { jornada, actaHtml, parseActaHtml };
