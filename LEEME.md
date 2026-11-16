# Almazora C Fantasy

Fantasy del C.D. Almazora 'C' (Tercera FFCV Grupo 2). Ficha jugadores, alinea 11 y suma puntos con las actas de cada jornada.

## Ponerlo en marcha (Vercel)

1. En Vercel: **Add New > Project**, elige `fantasyamc` y pulsa **Deploy** (Application Preset: Other, sin tocar nada más).
2. Dentro del proyecto: **Storage > Create Database > Upstash for Redis** (gratis) y conéctala al proyecto. Si ya tienes la de AlmaBet, puedes conectar esa misma: el fantasy guarda todo con el prefijo `fa:` y no se mezcla.
3. **Deployments > ⋯ > Redeploy** para que la web vea la base de datos.
4. Abre el enlace y **crea tu cuenta la primera**: la primera cuenta es la del administrador (mete las actas). Si otro se registra antes, en **Settings > Environment Variables** añade `ADMIN_USER` con tu usuario y haz Redeploy.
5. Pasa el enlace al grupo. En el móvil: Compartir > Añadir a pantalla de inicio.

## Cada jornada (administrador)

**Más > Admin**. Rival y hora ya vienen del calendario. Mete del acta: minutos de cada jugador, goles, amarillas (2 = doble) y roja. Pulsa **Publicar puntos**. Las alineaciones se cierran solas a la hora del partido.

## Reglas

- 18.000.000 € al empezar, máximo 15 fichas, 11 en la alineación. Con menos de 11 no puntúas.
- Capitán x2. Cada punto da 100.000 €. Recompensa diaria de 100.000 €.
- Puntos: juega <60' +1 / 60'+ +2 · gol POR +10, DEF +6, CEN +5, DEL +4 · portería a cero POR +4, DEF +3, CEN +1 · −1 por cada 2 goles encajados (POR/DEF) · victoria +2, empate +1 · amarilla −1, roja o doble amarilla −3 · gol en propia −2.
- Precios: cambian cada día a las 00:00 por oferta y demanda (fichajes − ventas del día anterior, +4 % por fichaje neto, tope ±12 %), popularidad (±1 %) y rendimiento (día después de publicar la jornada, (puntos − 3) × 4 %, entre −15 % y +25 %).
- J1–J8 vienen puntuadas con las actas reales (`datos/actas_almc.json`). El fantasy puntúa desde la J9.

## Ficheros

| Fichero | Para qué |
|---|---|
| `index.html` | La app (se genera con `python build.py` desde `src/app.html`) |
| `api/fantasy.js` | Servidor: cuentas, equipos y actas |
| `config.js` | Dice a la app dónde está el servidor |
| `manifest.json`, `sw.js`, `*.png` | Instalar como app con icono |
| `datos/` | Actas J1–J8 del Almazora C y el script que las extrae |
