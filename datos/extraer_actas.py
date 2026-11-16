import json,glob,unicodedata,collections
T="C.D. Almazora 'C'"
P={}  # id -> info
J={}
for f in sorted(glob.glob('/mnt/user-data/uploads/ALMABET/datos-liga/actas/J0*.json')):
  d=json.load(open(f))
  if T not in (d['local'],d['visitante']): continue
  n=d['jornada']; local=d['local']==T
  gl,gv=map(int,d['resultado'].split('-'))
  gf,gc=(gl,gv) if local else (gv,gl)
  rival=d['visitante'] if local else d['local']
  al=[a for a in d['alineaciones'] if a['equipo']==T][0]
  st={}
  def reg(x,tit):
    pid=x['id_jugador']; p=P.setdefault(pid,{'id':pid,'nombre':x['jugador'],'dorsales':collections.Counter(),'por':0})
    p['dorsales'][x['dorsal']]+=1; p['por']+= 1 if x.get('portero') else 0
    st[pid]={'m':90 if tit else 0,'g':0,'y':0,'r':False,'tit':tit,'in':None}
  for x in al['titulares']: reg(x,True)
  for x in al.get('suplentes',[]): reg(x,False)
  for s in d['sustituciones']:
    if s['equipo']!=T: continue
    mn=s['minuto']; o=s['sale']['id_jugador']; i=s['entra']['id_jugador']
    if o in st: st[o]['m']=min(st[o]['m'], mn) if st[o]['tit'] else max(0, mn-(st[o]['in'] or mn))
    if i in st: st[i]['in']=mn; st[i]['m']=90-mn
  mine=[g for g in d['goles'] if g['equipo']==T]
  excess = max(0, len(mine) - gf)   # "(gol)" de más = gol en propia puerta
  for g in mine:
    if g['id_jugador'] not in st: continue
    if excess and 'gol' in g['nota']:
      excess -= 1
      st[g['id_jugador']]['pp']=st[g['id_jugador']].get('pp',0)+1
    else: st[g['id_jugador']]['g']+=1
  for c in d['tarjetas']:
    if c['equipo']!=T or c['id_jugador'] not in st: continue
    s=st[c['id_jugador']]
    if c['tipo']=='amarilla': s['y']+=1
    elif 'amarilla' in c['tipo']: s['y']=2
    else: s['r']=True
    if s['y']>=2 or s['r']:
      start = 0 if s['tit'] else (s['in'] or 0)
      s['m']=max(1,min(s['m'], c['minuto']-start))
  out={}
  for pid,s in st.items():
    if s['m']>0 or s['g'] or s['y'] or s['r'] or s.get('pp'):
      out[pid]={'m':s['m'],**({'g':s['g']} if s['g'] else {}),**({'y':min(2,s['y'])} if s['y'] else {}),**({'r':True} if s['r'] else {}),**({'pp':s['pp']} if s.get('pp') else {})}
  hh,mm=d['hora'].split(':'); dd,mo,yy=d['fecha'].split('/')
  J[n]={'n':n,'rival':rival,'local':local,'gf':gf,'gc':gc,'inicio':f"{yy}-{mo}-{dd}T{hh}:{mm}",'st':out,'conv':list(st.keys()),'jugada':True}
for p in P.values():
  p['dorsal']=p['dorsales'].most_common(1)[0][0]; del p['dorsales']
  apps=[J[n]['st'].get(p['id']) for n in J]; p['pj']=sum(1 for a in apps if a and a['m']>0); p['goles']=sum((a or {}).get('g',0) for a in apps)
  p['conv']=sum(1 for n in J if p['id'] in J[n]['conv'])
json.dump({'players':list(P.values()),'jornadas':J},open('actas_almc.json','w'),ensure_ascii=False,indent=0)
for p in sorted(P.values(),key=lambda p:int(p['dorsal'])): print(p['dorsal'],p['nombre'],p['por'],p['conv'],p['pj'],p['goles'])
for n in sorted(J): print(n,J[n]['rival'],J[n]['gf'],J[n]['gc'],len(J[n]['st']))
