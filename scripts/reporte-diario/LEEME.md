# Bitácora diaria de trabajo del repo

Reporte "día por día" del trabajo de desarrollo en `loekemeyer/gestopclientes`:
cuántos commits, quién los hizo (según el trailer `Hecho-por`), en qué áreas
(sql / edge functions / docs / scripts / otros), la lista de asuntos de cada
commit y, cuando hay connector de Supabase, los problemas de auditoría
abiertos y cerrados ese día.

Se ve en un Artifact de claude.ai (tablero con una tarjeta por día, el más
nuevo arriba):

**https://claude.ai/artifact/MrKAWMDAPZAoAJBCM6rVBT**

## Las dos piezas

1. **`reporte-dia.mjs`** — saca los datos de git (sin red). Fechas en hora de
   Argentina.
   ```bash
   node scripts/reporte-diario/reporte-dia.mjs --ayer    # el día de ayer (lo que usa la Routine)
   node scripts/reporte-diario/reporte-dia.mjs --dia 2026-10-13
   node scripts/reporte-diario/reporte-dia.mjs --all      # todos los días con actividad (backfill)
   ```
   Con `--all` necesita el historial completo: si el checkout es shallow,
   `git fetch --unshallow` primero.

2. **Routine `Bitácora diaria GestOpClientes (08:00 ART)`**
   (`trig_012KVxRd3PrbzyGfys5hAnTn`) — cada día 08:07 ART abre una sesión
   nueva, corre el script para el día anterior, cuenta la auditoría y escribe
   ese día en el Artifact (colección `dias`, un documento por fecha
   `YYYY-MM-DD`).

## Backfill

El histórico desde el 25/08/2026 ya se cargó de una (28 días) corriendo el
script con `--all` y mezclando la auditoría de `github_repo_problemas`
(repo_id 190). La Routine solo agrega de ahí en adelante.

## Límite conocido

La Routine corre **sin el MCP de Supabase** (este org no deja adjuntar
connectors al crear la Routine por API). Resultado: el git sale completo, pero
los contadores de auditoría del día quedan en 0. Para que también cuente la
auditoría, recreá la Routine desde la UI de routines de claude.ai agregándole
el connector Supabase, con el mismo prompt.

## Esquema del documento en el Artifact

```json
{
  "dia": "2026-10-13",
  "commits": 36,
  "autores": [{ "nombre": "Pablo Olejavetzky", "n": 25 }, { "nombre": "Claude", "n": 11 }],
  "areas": { "sql": 2, "funciones": 44, "docs": 36, "scripts": 13, "otros": 31 },
  "asuntos": ["...", "..."],
  "audit": { "abiertos": 0, "cerrados": 0 },
  "fuente": "backfill"
}
```
