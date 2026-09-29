-- 086 — (APLICADA 29/09, falta verificar el regex y recargar wa_clientes_telefono) La copia de teléfonos de clientes (wa_clientes_telefono) ya no mezcla clientes de Chef (proyecto LK)
-- Pedido de Pablo Olejavetzky (29/09). Auditoría: problema 616.
--
-- Problema: sincronizar_ppp (cron diario 10:00) copia virgilio.whatsapp_clientes → wa_clientes_telefono. Esa tabla de
-- Gestión no tiene empresa: 171 teléfonos son SÓLO de clientes de Chef y quedaban colgados del código; en 43 casos
-- ese código existe en LK y el cliente de LK "tenía" el teléfono de un cliente de Chef (ej. 2360 Senki ← Indianapolis).
-- wa_identify_customer y los avisos leen esa tabla.
--
-- Arreglo: se sigue copiando whatsapp_clientes (tiene 198 teléfonos que no están en ninguna otra tabla), pero se saca
-- la fila si en GV_Clientes_Whatsapp (Gestión, con empresa) figura como de CH y no como de LK para ese código+teléfono.
--   · virgilio.gv_clientes_whatsapp: foreign table nueva (server virgilio_db). En Gestión se le dio SELECT a
--     lk_ppp_reader con la política lk_ppp_reader_sel (mismo patrón que el resto de las tablas que lee LK).
--   · Si Gestión falla, el bloque de teléfonos entero se deshace (EXCEPTION por bloque): la tabla queda como estaba.
-- Rollback: zz_backups.bkp_sincronizar_ppp_20260929.

create foreign table if not exists virgilio.gv_clientes_whatsapp (
  empresa text, cod_cliente text, telefono text, razon_social text, origen text, actualizado timestamptz
) server virgilio_db options (schema_name 'public', table_name 'GV_Clientes_Whatsapp');

create table if not exists zz_backups.bkp_sincronizar_ppp_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sincronizar_ppp';
alter table zz_backups.bkp_sincronizar_ppp_20260929 enable row level security;

do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.sincronizar_ppp'::regproc);
  viejo := E'    SELECT cod_cliente, telefono, actualizado\n    FROM virgilio.whatsapp_clientes\n    WHERE telefono IS NOT NULL AND btrim(telefono) <> '''';';
  nuevo := E'    -- Sin los teléfonos que son sólo de clientes de Chef (sql/086, auditoría 616).\n'
        || E'    WITH g AS MATERIALIZED (\n'
        || E'      SELECT empresa, cod_cliente, right(regexp_replace(telefono, ''\\D'', '''', ''g''), 10) AS t\n'
        || E'      FROM virgilio.gv_clientes_whatsapp)\n'
        || E'    SELECT w.cod_cliente, w.telefono, w.actualizado\n'
        || E'    FROM virgilio.whatsapp_clientes w\n'
        || E'    WHERE w.telefono IS NOT NULL AND btrim(w.telefono) <> ''''\n'
        || E'      AND NOT (EXISTS (SELECT 1 FROM g WHERE g.empresa = ''CH'' AND g.cod_cliente = w.cod_cliente::text\n'
        || E'                         AND g.t = right(regexp_replace(w.telefono, ''\\D'', '''', ''g''), 10))\n'
        || E'               AND NOT EXISTS (SELECT 1 FROM g WHERE g.empresa = ''LK'' AND g.cod_cliente = w.cod_cliente::text\n'
        || E'                         AND g.t = right(regexp_replace(w.telefono, ''\\D'', '''', ''g''), 10)));';
  if position(viejo in d) = 0 then raise exception 'sincronizar_ppp: no encontré el bloque de teléfonos a reemplazar'; end if;
  execute replace(d, viejo, nuevo);
end $$;

-- Recarga SÓLO de la tabla de teléfonos (sin correr sincronizar_ppp entero, que recarga ppp_facturacion y
-- dispararía avisos de despacho a media mañana):
--   delete from wa_clientes_telefono; insert ... (misma consulta que arriba)
