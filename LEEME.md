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
- Puntos (del acta): minutos 1–29' +1, 30–59' +2, 60–89' +3, 90' +4 · titular +1 · gol POR +10, DEF +6, CEN +5, DEL +4 (+2 doblete, +3 hat-trick) · gol de la victoria +2, del empate +1 · gol desde el banquillo +1 · portería a cero (60'+) POR +5, DEF +4, CEN +2, DEL +1 · goles encajados en el campo: POR −1 cada uno, DEF −1 cada 2 · victoria +3, empate +1, derrota −1 · goleada ±2 · capitán en el acta +1 · cambiado antes del descanso −1 · amarilla −1, doble −3, roja −4 · gol en propia −2.
- Ligas privadas: cada uno crea su liga (código de 6 letras) o se une a otra en Más > Ligas o tocando el nombre de arriba. Cada liga tiene sus plantillas, mercado, clasificación y actividad. Los precios son los mismos en todas: suben y bajan por rendimiento y por las pujas de todas las ligas. La liga de antes es la **ALMAC**. Al publicar una jornada se reparte en todas las ligas.
- Precios de salida (escala LaLiga Fantasy): 0 pts 0,5 M · media (~23 pts) ~10 M · 60 pts ~42 M · 100 pts ~100 M. La plantilla inicial (~100 M) no trae a nadie de más de 30 M.

## Cada jornada (administrador)

Descarga las actas de la jornada (JSON, como las de `ALMABET/datos-liga/actas`) y en **Más > Admin** súbelas todas a la vez. Revisa el resumen y pulsa **Publicar puntos**.

## Ficheros

| Fichero | Para qué |
|---|---|
| `index.html` | La app (se genera con `python build.py` desde `src/app.html`) |
| `game.js` | Reglas y puntos (los usan la app y el servidor) |
| `liga.json` | Equipos, jugadores, actas J1–J8 y calendario (`node datos/extraer_liga.js RUTA/datos-liga`) |
| `api/fantasy.js` | Servidor: cuentas, dinero, plantillas, pujas, precios y jornadas |
| `config.js`, `manifest.json`, `sw.js`, `*.png` | Configuración e instalar como app |
