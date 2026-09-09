-- 062 — Las "633 escalaciones pendientes" no eran escalaciones
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-09-09
--
-- ✅ APLICADO el 2026-09-09 con el OK del dueño. 632 filas re-etiquetadas.
--   Cola: 635 pendientes → **2**. Backup tomado antes (635 filas, la tabla entera).
--
-- ── Qué eran en realidad ───────────────────────────────────────────────────────────────────
-- La cola de "atender a mano" (`wa_alertas_humano`, estado `pendiente`) venía creciendo y se
-- leía como "clientes esperando respuesta". Medido el 09/09:
--
--   tipo                   pendientes   teléfonos
--   otro                        631         73     ← motivo: "whitelist_gate"
--   comprobante_error             1          1
--   comprobante_recibido          1          1
--
-- O sea **631 de 633 (99,7%)** eran el log del gate de whitelist: cada mensaje que llega al
-- número y no está en `wa_envio_contactos` deja una fila pidiendo atención humana.
--
-- Y no son clientes. De los 73 teléfonos, **uno solo** cruza contra `customers.whatsapp` o
-- `wa_clientes_telefono`. El grueso salió de un único evento:
--
--   día        alertas  teléfonos
--   01/09            3          3
--   02/09            4          2
--   03/09          534         54   ← 87% del total, todas desde las 15:22
--   04/09           29         12
--   07/09           45          6
--   08/09           16         16
--
-- El 03/09 a las 15:22 se mandó una encuesta desde esa línea y contestaron 54 personas:
-- "35/40min", "2 hs", "11 minutos", "A", "B". Tráfico ajeno al bot y a los clientes.
--
-- **El bot no le contestó a ninguno**: el gate aguantó. La última respuesta del bot a alguno de
-- esos números es del 01/09 y es el teléfono de prueba; en 03, 04, 07 y 08/09 hay 0 mensajes
-- `assistant` hacia ellos.
--
-- ── Lo que ya se arregló (código, `lk_whatsapp-webhook`) ────────────────────────────────────
-- El techo por teléfono y por día (v14.13, 07/09) funciona — el 08/09 fueron 16 alertas de 16
-- teléfonos, una cada uno. Lo que faltaba era que **no cayeran en la misma cola** que un
-- comprobante que falló. `avisarDescartePorWhitelist` v2 ahora separa por quién escribió:
--
--   · teléfono que resuelve a un cliente → `estado='pendiente'` (eso sí hay que mirarlo:
--     un cliente real escribió y el bot no le contestó por la whitelist)
--   · cualquier otro                     → `estado='descartado'` (queda el registro de qué
--     número intentó, pero no ensucia la cola)
--
-- Va además con `tipo='whitelist_gate'` en vez de `'otro'`, para filtrarlo sin leer el jsonb.
-- `descartado` ya estaba en el CHECK de `estado` (sql/044): no hace falta tocar la tabla.
--
-- ── Backup (ya tomado) ─────────────────────────────────────────────────────────────────────
--   public.bkp_wa_alertas_20260909  — copia completa de `wa_alertas_humano`, 633 filas,
--   con RLS prendida y sin grants para anon/authenticated.
--
--   Restore: update public.wa_alertas_humano a
--               set estado = b.estado, tipo = b.tipo
--              from public.bkp_wa_alertas_20260909 b
--             where b.id = a.id;

-- ── APLICADO: sacar las viejas de la cola ──────────────────────────────────────────────────
-- No borra nada. Sólo las saca de `pendiente` para que la cola muestre lo que de verdad hay que
-- atender. Después de correrlo deberían quedar 2 pendientes (el comprobante_error y el
-- comprobante_recibido del 01/09), no 633.

update public.wa_alertas_humano
   set estado = 'descartado',
       tipo = 'whitelist_gate',
       atendido_por = 'limpieza 2026-09-09 (no eran escalaciones)',
       atendido_at = now()
 where estado = 'pendiente'
   and contexto->>'motivo' = 'whitelist_gate';

-- Comprobar después:
--   select tipo, estado, count(*) from public.wa_alertas_humano group by 1,2 order by 3 desc;

-- ── ⚠ Aparte: qué se está guardando ────────────────────────────────────────────────────────
-- `contexto` guarda `texto_recibido` (200 caracteres) y `contact_name` de gente que no es
-- cliente ni tiene nada que ver con Loekemeyer — nombres de agenda y mensajes personales. Hoy
-- son 631 filas. Vale la pena decidir si eso se guarda, y por cuánto tiempo: alcanzaría con
-- registrar el teléfono y la fecha (que es lo único que se usa: "qué números intentaron") y no
-- el contenido del mensaje. Es una decisión del dueño, no se tocó nada.

-- ── Resultado medido ───────────────────────────────────────────────────────────────────────
--   tipo                   estado        antes   después
--   otro                   pendiente       632         0
--   whitelist_gate         descartado        1       633
--   comprobante_error      pendiente         1         1
--   comprobante_recibido   pendiente         1         1
--
-- La cola de "atender a mano" pasó de **635 a 2**, y las 2 que quedan son de verdad.
--
-- De paso quedó comprobado que el deploy del webhook anduvo: la fila `whitelist_gate` /
-- `descartado` que ya existía ANTES de correr este update la escribió el código nuevo, sola,
-- con un mensaje que entró después del deploy. O sea que la clasificación por cliente / no
-- cliente está funcionando en vivo, no sólo en el repo.
