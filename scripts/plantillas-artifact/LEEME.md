# Artifact "Plantillas de WhatsApp"

Página para el equipo (pedido de Pablo Olejavetzky, 29/09/2026) con las plantillas aprobadas en Meta del número
de Loekemeyer: cuándo sale cada una, para quién, qué dice y cuántas salieron en 30 días.

- **Link:** https://claude.ai/artifact/NxCBLWhQA9yghVk2mJ1Mcu
- **Se actualiza sola** todos los días (Routine "Plantillas WhatsApp diario", 07:51 hora AR) siguiendo los pasos de abajo.
- Una plantilla nueva en Meta aparece sola en "Sin clasificar" hasta que alguien le cargue el disparador en
  `disparadores.json` (el generador lo avisa por stderr).

## Archivos

| Archivo | Qué es |
|---|---|
| `disparadores.json` | Qué dispara cada plantilla, grupo, para quién y estado (conectada / prueba / sin_disparador / legado / otro_sistema). **A mano**: actualizar cuando cambia un trigger (sql/078, sql/079, lk_factura-check, asoc-timeout-cron). |
| `pagina.html` | La página; se arma sola desde los datos embebidos. |
| `generar.mjs` | Junta datos + disparadores + texto definido en `_shared/plantillas-meta.ts` (marca si Meta difiere). |
| `datos.sql` | Consulta que arma `datos.json` (sólo lectura). |

## Pasos para actualizar (lo que hace la Routine)

1. Pedir la lista a Meta (proyecto PaginaLK `kwkclwhmoygunqmlegrg`, sólo lectura, no manda mensajes):
   ```sql
   select net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_templates',
     headers := jsonb_build_object('Content-Type','application/json','x-lk-secret', krikos_secret('LK_FN_CRON_SECRET')),
     body := jsonb_build_object('action','templates_list'), timeout_milliseconds := 30000);
   ```
   Devuelve un id. Esperar ~5 s y confirmar `status_code = 200` en `net._http_response` con ese id.
2. Correr `datos.sql` reemplazando `:ID` por ese id. Guardar el texto de la columna `datos` tal cual en
   `datos.json` (fuera del repo, en el scratchpad).
3. `node --experimental-strip-types scripts/plantillas-artifact/generar.mjs <datos.json> <plantillas-whatsapp.html>`.
   Si sale con error o con menos de 30 plantillas, **no publicar** (Meta o la consulta fallaron).
4. Leer el artifact (`Artifact` action `read` con el link) y publicar el HTML generado con `url` = el link.
5. Si el generador avisó "sin disparador cargado", dejarlo anotado como tarea en Planify para Pablo (employee_id 64).
