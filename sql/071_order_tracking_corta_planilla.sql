-- 071 — La planilla "PPP Online" deja de escribir order_tracking (proyecto LK)
-- Luis, 2026-09-25: "sí, cortala y corré el feed de Gestión".
-- ESTADO: APLICADO el 2026-09-25.
--
-- Por qué: el Apps Script syncTrackingToSupabase de la planilla "PPP Online" (resto de
-- Producción Virgilio) llama cada 5 min a esta función con la programación VIEJA: pisaba el
-- estado/fecha, BORRABA todo pedido que no estuviera en la planilla y encolaba avisos en
-- bot_pending_notifications. Deshacía el feed de Gestión (sql/069) a los 5 minutos
-- (medido: 09:45 feed → 09:50 planilla restauró 1.115 filas).
--
-- Corte quirúrgico (D007): la función sigue existiendo con la misma firma, así el script de la
-- planilla no da error, pero no escribe ni borra nada. Las filas viejas (pedidos < 1340, que la
-- página y la solapa Tracking usan de respaldo) quedan como están.

create or replace function public.sync_order_tracking_from_sheet(p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  -- 071 (2026-09-25): desactivada. La fuente de order_tracking es Gestión
  -- (sync_order_tracking_from_gestion, cron sync-order-tracking-gestion).
  RETURN jsonb_build_object(
    'received', CASE WHEN jsonb_typeof(p_rows) = 'array' THEN jsonb_array_length(p_rows) ELSE 0 END,
    'inserted', 0, 'updated', 0, 'deleted', 0, 'notifications_queued', 0,
    'skipped', 'desactivada: la fuente de order_tracking es Gestion (sql/071)',
    'synced_at', now());
END;
$function$;

-- Rollback: volver a crear la versión anterior (texto completo guardado abajo, tomado con
-- pg_get_functiondef el 25/09 antes de aplicar).
-- CREATE OR REPLACE FUNCTION public.sync_order_tracking_from_sheet(p_rows jsonb)
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_total_in       int;
--   v_inserted       int := 0;
--   v_updated        int := 0;
--   v_deleted        int := 0;
--   v_notif_count    int := 0;
--   v_sheet_nps      text[];
-- BEGIN
--   IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
--     RAISE EXCEPTION 'p_rows debe ser un array JSON';
--   END IF;
--   v_total_in := jsonb_array_length(p_rows);
-- 
--   CREATE TEMP TABLE tmp_sync ON COMMIT DROP AS
--   SELECT DISTINCT ON (r.np_number)
--     r.np_number,
--     NULLIF(TRIM(r.cod_cliente::text), '')::int AS cod_cliente,
--     LOWER(NULLIF(TRIM(r.status), '')) AS status,
--     CASE
--       WHEN r.fecha_entrega IS NULL OR TRIM(r.fecha_entrega) = '' THEN NULL
--       WHEN TRIM(r.fecha_entrega) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
--         SUBSTRING(TRIM(r.fecha_entrega) FROM 1 FOR 10)::date
--       ELSE NULL
--     END AS fecha_entrega
--   FROM jsonb_to_recordset(p_rows) AS r(
--     np_number text, cod_cliente text, status text, fecha_entrega text
--   )
--   WHERE r.np_number IS NOT NULL AND TRIM(r.np_number) <> ''
--     AND r.status IS NOT NULL AND TRIM(r.status) <> ''
--   ORDER BY r.np_number, r.fecha_entrega DESC NULLS LAST;
-- 
--   -- (a) Nuevos pedidos: solo encolar si cliente esta asociado a WhatsApp en bot
--   INSERT INTO public.bot_pending_notifications
--     (np_number, cod_cliente, tipo, status_anterior, status_nuevo, fecha_nueva)
--   SELECT t.np_number, t.cod_cliente,
--          CASE WHEN t.status = 'entregado' THEN 'entregado' ELSE 'programado' END,
--          NULL, t.status, t.fecha_entrega
--   FROM tmp_sync t
--   WHERE t.status IN ('programado','entregado')
--     AND NOT EXISTS (SELECT 1 FROM public.order_tracking ot WHERE ot.np_number = t.np_number)
--     AND EXISTS (
--       SELECT 1 FROM public.bot_customer_whatsapps cw
--       WHERE cw.cod_cliente = t.cod_cliente
--     );
-- 
--   -- (b) Cambio de status hacia programado/entregado
--   INSERT INTO public.bot_pending_notifications
--     (np_number, cod_cliente, tipo, status_anterior, status_nuevo, fecha_anterior, fecha_nueva)
--   SELECT t.np_number, t.cod_cliente,
--          CASE WHEN t.status = 'entregado' THEN 'entregado' ELSE 'programado' END,
--          ot.status, t.status, ot.fecha_entrega, t.fecha_entrega
--   FROM tmp_sync t
--   JOIN public.order_tracking ot ON ot.np_number = t.np_number
--   WHERE t.status IN ('programado','entregado')
--     AND LOWER(ot.status) <> t.status
--     AND EXISTS (
--       SELECT 1 FROM public.bot_customer_whatsapps cw
--       WHERE cw.cod_cliente = t.cod_cliente
--     );
-- 
--   -- (c) Cambio de fecha en programado
--   INSERT INTO public.bot_pending_notifications
--     (np_number, cod_cliente, tipo, status_anterior, status_nuevo, fecha_anterior, fecha_nueva)
--   SELECT t.np_number, t.cod_cliente,
--          'fecha_cambio', ot.status, t.status, ot.fecha_entrega, t.fecha_entrega
--   FROM tmp_sync t
--   JOIN public.order_tracking ot ON ot.np_number = t.np_number
--   WHERE t.status = 'programado'
--     AND LOWER(ot.status) = 'programado'
--     AND t.fecha_entrega IS DISTINCT FROM ot.fecha_entrega
--     AND t.fecha_entrega IS NOT NULL
--     AND EXISTS (
--       SELECT 1 FROM public.bot_customer_whatsapps cw
--       WHERE cw.cod_cliente = t.cod_cliente
--     );
-- 
--   GET DIAGNOSTICS v_notif_count = ROW_COUNT;
-- 
--   WITH ins AS (
--     INSERT INTO public.order_tracking (np_number, cod_cliente, status, fecha_entrega, updated_at)
--     SELECT np_number, cod_cliente, status, fecha_entrega, now() FROM tmp_sync
--     ON CONFLICT (np_number) DO UPDATE
--       SET cod_cliente   = EXCLUDED.cod_cliente,
--           status        = EXCLUDED.status,
--           fecha_entrega = EXCLUDED.fecha_entrega,
--           updated_at    = now()
--       WHERE order_tracking.status         IS DISTINCT FROM EXCLUDED.status
--          OR order_tracking.fecha_entrega  IS DISTINCT FROM EXCLUDED.fecha_entrega
--          OR order_tracking.cod_cliente    IS DISTINCT FROM EXCLUDED.cod_cliente
--     RETURNING (xmax = 0) AS inserted_new
--   )
--   SELECT
--     COUNT(*) FILTER (WHERE inserted_new),
--     COUNT(*) FILTER (WHERE NOT inserted_new)
--   INTO v_inserted, v_updated FROM ins;
-- 
--   SELECT ARRAY_AGG(np_number) INTO v_sheet_nps FROM tmp_sync;
--   DELETE FROM public.order_tracking
--   WHERE np_number <> ALL(COALESCE(v_sheet_nps, ARRAY[]::text[]));
--   GET DIAGNOSTICS v_deleted = ROW_COUNT;
-- 
--   RETURN jsonb_build_object(
--     'received',           v_total_in,
--     'inserted',           v_inserted,
--     'updated',            v_updated,
--     'deleted',            v_deleted,
--     'notifications_queued', v_notif_count,
--     'synced_at',          now()
--   );
-- END;
-- $function$
