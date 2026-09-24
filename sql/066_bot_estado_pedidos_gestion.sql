-- 066 — El seguimiento de pedidos del bot sale de GESTIÓN VIRGILIO, no de la planilla.
--
-- Problema (medido 24/09/2026): `order_tracking` la llena `sync_order_tracking_from_sheet`
-- desde la planilla "PPP Online" (Apps Script), que armaba Producción Virgilio. Desde que la
-- operación pasó a Gestión la planilla no trae más programados ni entregados: de los pedidos
-- desde el nº 1400, 0 `programado`, 0 `entregado`, 61 `#VALUE!` y 25 `recibido` sin fecha.
-- El bot contestaba "recibido" (o nada) a pedidos que ya tenían día de entrega.
--
-- Fuente nueva: `virgilio.gv_pedido_web_estado_pagina` (FDW, la MISMA que ya usan las páginas
-- con `gv_estado_mis_pedidos`). Cubre los pedidos que manejó Gestión (desde el nº 1340).
-- Lo anterior cae a `order_tracking`, que para esos pedidos viejos está bien.
-- El `#VALUE!` de la planilla NO se muestra nunca: es una fórmula rota, no un estado.
--
-- Rollback: la definición anterior de `bot_mi_entrega` está al final de este archivo.

create or replace function public.bot_estado_pedidos_gv(p_ids bigint[])
returns table(order_id bigint, status text, fecha_entrega date, fuente text)
language sql stable security definer set search_path to 'public'
as $$
  with g as (
    select g.order_id, g.estado, g.fecha_entrega, g.entregado, g.facturado, g.entregado_at
      from virgilio.gv_pedido_web_estado_pagina g
     where g.empresa = 'lk' and g.order_id = any(coalesce(p_ids, '{}'))
  )
  select i.id,
         case
           when g.order_id is not null then
             case when g.entregado            then 'entregado'
                  when g.facturado            then 'facturado'
                  when g.estado = 'programado' then 'programado'
                  when g.estado = 'sin_programar' then 'recibido'
                  else 'en preparacion' end
           when lower(ot.status) in ('recibido','programado','entregado','a programar','a_programar')
             then lower(ot.status)
           else 'recibido'
         end,
         case
           when g.order_id is not null then
             case when g.entregado then coalesce((g.entregado_at at time zone 'America/Argentina/Buenos_Aires')::date, g.fecha_entrega)
                  when g.estado = 'sin_programar' then null   -- sin programar: no se promete fecha
                  else g.fecha_entrega end
           when lower(ot.status) in ('programado','entregado') then ot.fecha_entrega
         end,
         case when g.order_id is not null then 'gestion'
              when ot.np_number is not null then 'planilla'
              else 'sin_dato' end
    from unnest(coalesce(p_ids, '{}')) i(id)
    left join g on g.order_id = i.id
    left join public.order_tracking ot on ot.np_number = i.id::text;
$$;

revoke execute on function public.bot_estado_pedidos_gv(bigint[]) from public, anon, authenticated;
grant  execute on function public.bot_estado_pedidos_gv(bigint[]) to service_role;

-- Misma firma que antes: el bot (bot-conversation.ts → consultar_mi_entrega) no cambia.
create or replace function public.bot_mi_entrega(p_telefono text)
returns table(np_number text, status text, fecha_entrega date, fecha_pedido date)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_cod  int;
  v_cid  uuid;
  v_ids  bigint[];
begin
  select cw.cod_cliente, cw.customer_id into v_cod, v_cid
    from public.bot_customer_whatsapps cw
   where regexp_replace(coalesce(cw.whatsapp,''), '[^0-9]', '', 'g')
       = regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g')
     and regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g') <> ''
   order by cw.is_primary desc, cw.created_at desc
   limit 1;

  if v_cod is null and v_cid is null then return; end if;

  -- Pedidos del cliente de los últimos 2 meses (por customer_id o por su código en LK).
  -- Sólo pedidos que se ENVIARON (sheets_sent): un pedido que nunca salió de la página
  -- (ej. los del bug de sheets_payload del 11-14/09) no tiene estado que informar.
  select array_agg(o.id) into v_ids
    from public.orders o
   where o.created_at >= current_date - interval '2 months'
     and o.sheets_sent is not false
     and (o.customer_id = v_cid
          or o.customer_id in (select c.id from public.customers c where c.cod_cliente = v_cod));

  if v_ids is null then return; end if;

  return query
  select e.order_id::text, e.status, e.fecha_entrega, (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date
    from public.bot_estado_pedidos_gv(v_ids) e
    join public.orders o on o.id = e.order_id
   order by case e.status
              when 'recibido'       then 0
              when 'programado'     then 1
              when 'en preparacion' then 1
              when 'facturado'      then 2
              else 3 end,
            e.fecha_entrega desc nulls last, o.created_at desc
   limit 15;
end;
$function$;

revoke execute on function public.bot_mi_entrega(text) from public, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK: definición anterior de bot_mi_entrega (leía sólo order_tracking)
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION public.bot_mi_entrega(p_telefono text)
--  RETURNS TABLE(np_number text, status text, fecha_entrega date, fecha_pedido date)
--  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $function$
-- DECLARE v_cod_cliente int;
-- BEGIN
--   SELECT cw.cod_cliente INTO v_cod_cliente FROM public.bot_customer_whatsapps cw
--   WHERE regexp_replace(COALESCE(cw.whatsapp,''), '[^0-9]', '', 'g')
--       = regexp_replace(COALESCE(p_telefono,''), '[^0-9]', '', 'g')
--     AND regexp_replace(COALESCE(p_telefono,''), '[^0-9]', '', 'g') <> ''
--   ORDER BY cw.is_primary DESC, cw.created_at DESC LIMIT 1;
--   IF v_cod_cliente IS NULL THEN RETURN; END IF;
--   RETURN QUERY
--   SELECT ot.np_number, LOWER(ot.status) AS status, ot.fecha_entrega, o.created_at::date AS fecha_pedido
--   FROM public.order_tracking ot LEFT JOIN public.orders o ON o.id::text = ot.np_number
--   WHERE ot.cod_cliente = v_cod_cliente
--     AND ( LOWER(ot.status) IN ('programado','recibido','a programar','a_programar')
--        OR ( LOWER(ot.status) = 'entregado' AND ot.fecha_entrega IS NOT NULL
--             AND ot.fecha_entrega >= (CURRENT_DATE - INTERVAL '2 months') ) )
--   ORDER BY CASE WHEN LOWER(ot.status) IN ('a programar','a_programar') THEN 0
--                 WHEN LOWER(ot.status) IN ('programado','recibido') THEN 1 ELSE 2 END,
--            ot.fecha_entrega DESC NULLS LAST, ot.updated_at DESC
--   LIMIT 15;
-- END; $function$;
