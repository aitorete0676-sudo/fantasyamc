# Genera ../liga.json con todos los jugadores del grupo 2 y sus estadísticas por jornada a partir de las actas.
# Uso: python extraer_liga.py RUTA/datos-liga   (la carpeta con actas/, jornadas.json y equipaciones.json)
import json, glob, sys, re, collections, os, unicodedata
SRC = sys.argv[1] if len(sys.argv) > 1 else "datos-liga"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "liga.json")
cal = json.load(open(os.path.join(SRC, "jornadas.json"), encoding="utf-8"))
kits = {k["team"]: k for k in json.load(open(os.path.join(SRC, "equipaciones.json"), encoding="utf-8"))}

def short(t):
    s = re.sub(r"\b(C\.\s?D\.|C\.\s?F\.|F\.\s?C\.|S\.A\.D\.|C\.\s?E\.|U\.\s?D\.|FÚTBOL CLUB|F\.C\.)", "", t, flags=re.I)
    s = s.replace("'", "").replace("C. F.", "").replace("de Castellón", "").strip()
    s = re.sub(r"\s+", " ", s).strip(" .")
    s = s.title() if s.isupper() else s
    return s
TEAMS, TIDX = [], {}
def tid(name):
    if name not in TIDX:
        k = kits.get(name) or next((v for kk, v in kits.items() if kk.lower() == name.lower()), {})
        TIDX[name] = len(TEAMS); TEAMS.append({"name": name, "short": short(name), "kit": k.get("camiseta", ""), "pant": k.get("pantalon", "")})
    return TIDX[name]

NICK = {"SERGIO DOMENECH ESTEVE": "Chechu", "GIUSEPPE DI BENEDETTO": "Adriano", "GENNIE ALBERTO MORENO COLLAZOS": "Gennie"}
POS_FIX = {  # posiciones conocidas del Almazora C
 "MARC CONDE MARTÍ": "POR", "MANEL LLOP HERRANDO": "POR", "DANIEL MUÑOZ TRUJILLO": "DEF", "ARIEL CABANES CLARAMONTE": "DEF", "SERGI CATALA MEZQUITA": "DEF",
 "ALEJANDRO MARTINEZ VENTURA": "DEF", "IKER MEDIAVILLA FERRER": "DEF", "SERGIO DOMENECH ESTEVE": "DEF", "TOMAS BALAGUE GARCIA": "DEF", "ASIER ALVARADO BARTOLL": "DEF",
 "UNAI ARNAU MORENO": "DEF", "CESAR LUIS BLACIO CASTRO": "DEF", "VICTOR DE LA TORRE ABRIL": "CEN", "RAMON HERRANDO BORILLO": "CEN", "ARNAU BADAL PRADES": "CEN",
 "MARC ESCOBAR AGOST": "CEN", "GIUSEPPE DI BENEDETTO": "CEN", "JUAN DEVESA CERVERA": "CEN", "AITOR JIMENEZ VILLENA": "CEN", "ALEX FERNANDEZ FABREGAT": "CEN",
 "GENNIE ALBERTO MORENO COLLAZOS": "CEN", "ALEJANDRO GRIGORE": "DEL", "CARLOS MOLINER CANO": "DEL", "RAMÓN TERCERO VAZQUEZ": "DEL"}
def disp(full):
    if full in NICK: return NICK[full]
    w = full.title().split()
    return w[0] + " " + w[1] if len(w) >= 3 else " ".join(w)

P = {}; J = {}
for f in sorted(glob.glob(os.path.join(SRC, "actas", "J*.json"))):
    d = json.load(open(f, encoding="utf-8")); n = d["jornada"]
    hg, ag = map(int, d["resultado"].split("-"))
    th, ta = tid(d["local"]), tid(d["visitante"])
    hh, mm = d["hora"].split(":"); dd, mo, yy = d["fecha"].split("/")
    JJ = J.setdefault(n, {"n": n, "matches": [], "st": {}})
    JJ["matches"].append([th, ta, hg, ag, f"{yy}-{mo}-{dd}T{hh}:{mm}"])
    for al in d["alineaciones"]:
        team = al["equipo"]; t = tid(team); gf, gc = (hg, ag) if team == d["local"] else (ag, hg)
        st = {}
        def reg(x, tit):
            pid = x["id_jugador"]
            p = P.setdefault(pid, {"id": pid, "full": x["jugador"], "t": t, "dors": collections.Counter(), "por": 0, "apps": 0, "g": 0})
            p["t"] = t; p["dors"][x["dorsal"]] += 1; p["por"] += 1 if x.get("portero") else 0
            st[pid] = {"m": 90 if tit else 0, "g": 0, "y": 0, "r": 0, "pp": 0, "tit": tit, "in": None}
        for x in al.get("titulares", []): reg(x, True)
        for x in al.get("suplentes", []): reg(x, False)
        for s in d["sustituciones"]:
            if s["equipo"] != team: continue
            mn = s["minuto"]; o = s["sale"]["id_jugador"]; i = s["entra"]["id_jugador"]
            if o in st: st[o]["m"] = min(st[o]["m"], mn) if st[o]["tit"] else max(0, mn - (st[o]["in"] or mn))
            if i in st: st[i]["in"] = mn; st[i]["m"] = 90 - mn
        mine = [g for g in d["goles"] if g["equipo"] == team]
        excess = max(0, len(mine) - gf)   # "(gol)" de más = gol en propia puerta
        for g in mine:
            if g["id_jugador"] not in st: continue
            if excess and "gol" in g["nota"]: excess -= 1; st[g["id_jugador"]]["pp"] += 1
            else: st[g["id_jugador"]]["g"] += 1
        for c in d["tarjetas"]:
            if c["equipo"] != team or c["id_jugador"] not in st: continue
            s = st[c["id_jugador"]]
            if c["tipo"] == "amarilla": s["y"] += 1
            elif "amarilla" in c["tipo"]: s["y"] = 2
            else: s["r"] = 1
            if s["y"] >= 2 or s["r"]:
                start = 0 if s["tit"] else (s["in"] or 0); s["m"] = max(1, min(s["m"], c["minuto"] - start))
        for pid, s in st.items():
            if s["m"] > 0: P[pid]["apps"] += 1; P[pid]["g"] += s["g"]
            if s["m"] > 0 or s["g"] or s["y"] or s["r"] or s["pp"]:
                JJ["st"][pid] = [t, s["m"], s["g"], min(2, s["y"]), s["r"], s["pp"]]
# posiciones: portero en el acta → POR; Almazora C conocidas; resto por dorsal y goles
DEF_D = {"2", "3", "4", "5", "12", "15"}
players = []
for p in P.values():
    dor = p["dors"].most_common(1)[0][0]
    if p["full"] in POS_FIX: pos = POS_FIX[p["full"]]
    elif p["por"] > 0: pos = "POR"
    elif p["g"] >= 3 or (p["apps"] and p["g"] / p["apps"] >= 0.4) or dor == "9": pos = "DEL"
    elif dor in DEF_D: pos = "DEF"
    elif dor in {"7", "11"} and p["g"] >= 1: pos = "DEL"
    else: pos = "CEN"
    players.append({"id": p["id"], "n": disp(p["full"]), "full": p["full"].title(), "t": p["t"], "pos": pos, "d": int(dor) if dor.isdigit() else 0})
players.sort(key=lambda x: (TEAMS[x["t"]]["short"], x["d"]))
calendar = {}
for j in cal["jornadas"]:
    for m in j["partidos"]:
        if m["jugado"]: continue
        dd, mo, yy = m["fecha"].split("/")
        calendar.setdefault(j["jornada"], []).append([tid(m["local"]), tid(m["visitante"]), f"{yy}-{mo}-{dd}T{m['hora'] or '12:00'}", m["codacta"]])
for n in J: J[n]["matches"].sort(key=lambda x: x[4])
json.dump({"generado": "actas FFCV J1-J%d" % max(J), "teams": TEAMS, "players": players, "jornadas": {str(k): J[k] for k in sorted(J)}, "calendar": {str(k): v for k, v in sorted(calendar.items())}},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("equipos", len(TEAMS), "jugadores", len(players), collections.Counter(p["pos"] for p in players), "bytes", os.path.getsize(OUT))
