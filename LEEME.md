# Almazora C Fantasy

Fantasy de la Tercera FFCV Grupo 2 (los 16 equipos, 392 jugadores). Cada jugador tiene un solo dueño y se ficha por pujas a ciegas de 24 h.

## Ponerlo en marcha (Vercel)

1. Vercel: **Add New > Project**, `fantasyamc`, **Deploy** (preset Other).
2. **Storage**: conecta una base **Upstash for Redis** (puede ser la misma de AlmaBet: el fantasy usa el prefijo `fa2:`).
3. **Deployments > ⋯ > Redeploy**.
4. Abre el enlace y crea tu cuenta la primera: es la del administrador. Si no, en **Settings > Environment Variables** añade `ADMIN_USER` con tu usuario y haz Redeploy.

## Cómo funciona

- Al crear la cuenta: 100 M € y una plantilla aleatoria de 15 jugadores (2 POR, 5 DEF, 5 CEN, 3 DEL) que vale unos 100 M €.
- Mercado: cada día a las 00:00 (hora de Madrid) salen 12 jugadores libres. Pujas a ciegas hasta las 00:00; gana la más alta. También puedes poner tus jugadores a la venta o vendérselos a LIGA al momento.
- Alineación de 11 antes del primer partido de la jornada (se cierra sola). Capitán x2. Cada punto = 100.000 €. Recompensa diaria 100.000 €.
- Precios: salen de los puntos de la temporada y cambian cada día por demanda (pujas), ventas sin pujas y rendimiento en la última jornada.
- Puntos (del acta): juega <60' +1 / 60'+ +2 · gol POR +10, DEF +6, CEN +5, DEL +4 · portería a cero POR +4, DEF +3, CEN +1 · −1 por cada 2 goles encajados (POR/DEF) · victoria +2, empate +1 · amarilla −1, roja o doble amarilla −3 · gol en propia −2.

## Cada jornada (administrador)

Descarga las actas de la jornada (JSON, como las de `ALMABET/datos-liga/actas`) y en **Más > Admin** súbelas todas a la vez. Revisa el resumen y pulsa **Publicar puntos**.

## Ficheros

| Fichero | Para qué |
|---|---|
| `index.html` | La app (se genera con `python build.py` desde `src/app.html`) |
| `game.js` | Reglas y puntos (los usan la app y el servidor) |
| `liga.json` | Equipos, jugadores, actas J1–J8 y calendario (`python datos/extraer_liga.py RUTA/datos-liga`) |
| `api/fantasy.js` | Servidor: cuentas, dinero, plantillas, pujas, precios y jornadas |
| `config.js`, `manifest.json`, `sw.js`, `*.png` | Configuración e instalar como app |
