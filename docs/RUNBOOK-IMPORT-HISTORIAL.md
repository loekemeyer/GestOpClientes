# Runbook — cargar la memoria del WhatsApp humano el día del lanzamiento

Pablo Olejavetzky, 14/10/2026. **Decisión:** la memoria del WhatsApp humano (cliente↔vendedor por
fuera del bot) se carga **el día que se arranca con clientes**, no antes: si se importa ahora, entre
hoy y el lanzamiento vuelve a quedar desactualizada. Lo hace **Claude desde Claude in Chrome**, con
la muestra del export que pase Pablo.

## Qué ya está resuelto (no se vuelve a tocar)

- La herramienta `buscar_en_mi_historial` + RPC `bot_buscar_mi_historial` (sql/149) ya leen:
  - el **año importado** (`Wpp_Historial_Clientes`, 2025-06-09 a 2026-06-09), y
  - **lo vivo del bot** (`bot_historial_chat`), en vivo — eso nunca se desactualiza.
- Lo ÚNICO que falta cargar es el **tramo humano 2026-06-10 → día del lanzamiento**.
- El importador con dedup ya está escrito en `sql/150_import_historial_humano.sql` (**sin aplicar**).

## Lo que falta de Pablo (sin esto no se puede)

1. **Quién** exporta el WhatsApp Business humano y **de dónde** (WhatsApp Business app/web, un panel, un ZIP).
2. **Una muestra del formato** (un chat exportado de ejemplo), para escribir el parser exacto.

## Pasos del día (Claude)

1. **Leer la skill `chrome-browser`** antes de tocar Claude in Chrome (son las herramientas
   `mcp__claude-in-chrome__*`). Confirmar con Pablo qué pestañas abre.
2. **Exportar / leer** el WhatsApp humano desde Claude in Chrome y **parsear** cada mensaje a:
   `cod_cli, marca (LK/CH), telefono, rol (user = cliente, assistant = empresa/vendedor), contenido, creado_en`.
   - El `cod_cli` + `marca` se resuelven por el teléfono del chat (misma lógica que `bot_cliente_por_whatsapp`:
     match por dígitos contra `bot_customer_whatsapps`, y la **empresa** del teléfono define LK vs CH —
     cod es independiente entre las dos). Un chat cuyo teléfono no resuelve a un cliente, se deja afuera y se lista.
3. **Aplicar** `sql/150` (crea `wa_import_historial_staging` + la función), con el "sí" de Pablo (es DDL nuevo).
4. **Cargar** las filas parseadas en `wa_import_historial_staging` (INSERT por lotes; la escritura va con la
   excepción de BD del repo, se informa el SQL y se verifica con un SELECT de conteo).
5. **Correr el import:** `select * from public.wa_importar_historial_staging('humano_gap');`
   Crea una conversación nueva por cliente e inserta con **dedup** (misma fecha + mismo texto no se repite:
   idempotente, se puede correr dos veces sin duplicar).
6. **Verificar** (queries al pie de `sql/150`): rango de fechas de `fuente='whatsapp_humano'`, conteo por marca,
   y probar `bot_buscar_mi_historial('<telefono>', '<palabra>', 6)` con un cliente del tramo nuevo.
7. **Vaciar el staging** cuando esté OK: `truncate public.wa_import_historial_staging;` (pide el "sí": es un borrado).
8. **Opcional — rearmar fichas** de los clientes con tramo nuevo (los 7 rasgos estables quedan un poco viejos; la
   recuperación granular NO lo necesita). Gasta Haiku: va con **estimativo + "sí"** (regla de gasto). `lk_memoria-cliente`.

## Qué NO hace falta

- Rearmar la herramienta ni el prompt: `buscar_en_mi_historial` lee `Wpp_Historial_Clientes` directo, así que apenas
  se carga el staging queda al día.
- Embeddings: el volumen por cliente es chico (decisión del 09/10, `REQUERIMIENTOS-AGENTE-2026-10-09.md`).

## Aislamiento (no romper)

El filtro del año va por `(cod_cli, marca)` con la **empresa del teléfono**; cod 411 en LK y en CH son clientes
distintos. El importador respeta eso: cada fila del staging lleva su `marca` y se linkea a ese cliente.
