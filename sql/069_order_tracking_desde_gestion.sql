-- 069 — order_tracking se alimenta de GESTIÓN, no de la planilla de Producción (proyecto LK)
-- Pedido de Luis (Planify «Bot WA: seguimiento de pedidos desde Gestión»).
-- ESTADO: ESCRITO, NO APLICADO. Se aplica con el "sí" de Luis.
--
-- Fuente: virgilio.gv_pedido_web_estado_pagina (FDW a Gestión; la misma que ya usa
-- bot_estado_pedidos_gv, sql/066). estado ← programación (PPP_Web_Programacion) y entregado ← CRN.
--   entregado                  → 'entregado', fecha = día del CRN (o la programada)
--   estado = 'sin_programar'   → 'recibido',  sin fecha
--   resto (programado/pickeado/armado/facturado) → 'programado', fecha programada
--
-- Principio D007 (vasectomía): esto SÍ dispara el trigger order_tracking_wa_notify, que encola en
-- wa_outbox como en producción. No sale nada: la llave wa_envio_automatico está en '0' y
-- bot_customer_whatsapps está vacía. No se apaga ningún trigger.
--
-- Medido el 25/09 (simulación sin escribir): 151 pedidos LK → 17 nuevos, 130 que cambian
-- estado/fecha (54 entregado · 85 programado · 12 recibido). 1 programado sin cod_cliente.

create or replace function public.sync_order_tracking_from_gestion()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ins int := 0; v_upd int := 0;
begin
  with g as (
    select g.order_id::text as np,
           c.cod_cliente,
           case when g.entregado then 'entregado'
                when g.estado = 'sin_programar' then 'recibido'
                else 'programado' end as status,
           case when g.entregado then coalesce((g.entregado_at at time zone 'America/Argentina/Buenos_Aires')::date, g.fecha_entrega)
                when g.estado = 'sin_programar' then null
                else g.fecha_entrega end as fe
      from virgilio.gv_pedido_web_estado_pagina g
      left join public.orders o on o.id = g.order_id
      left join public.customers c on c.id = o.customer_id
     where g.empresa = 'lk'
  ), up as (
    update public.order_tracking ot
       set status = g.status, fecha_entrega = g.fe,
           cod_cliente = coalesce(g.cod_cliente, ot.cod_cliente), updated_at = now()
      from g
     where ot.np_number = g.np
       and (ot.status is distinct from g.status or ot.fecha_entrega is distinct from g.fe)
    returning 1
  )
  select count(*) into v_upd from up;

  with g as (
    select g.order_id::text as np, c.cod_cliente,
           case when g.entregado then 'entregado'
                when g.estado = 'sin_programar' then 'recibido'
                else 'programado' end as status,
           case when g.entregado then coalesce((g.entregado_at at time zone 'America/Argentina/Buenos_Aires')::date, g.fecha_entrega)
                when g.estado = 'sin_programar' then null
                else g.fecha_entrega end as fe
      from virgilio.gv_pedido_web_estado_pagina g
      left join public.orders o on o.id = g.order_id
      left join public.customers c on c.id = o.customer_id
     where g.empresa = 'lk'
  ), ins as (
    insert into public.order_tracking (np_number, status, fecha_entrega, cod_cliente, updated_at)
    select g.np, g.status, g.fe, g.cod_cliente, now() from g
     where not exists (select 1 from public.order_tracking ot where ot.np_number = g.np)
    returning 1
  )
  select count(*) into v_ins from ins;

  return jsonb_build_object('insertados', v_ins, 'actualizados', v_upd);
end;
$function$;

revoke all on function public.sync_order_tracking_from_gestion() from public, anon, authenticated;

-- Cada 15 min, en minutos que no pisan sync-pedidos-match-virgilio (11-59/15).
select cron.schedule('sync-order-tracking-gestion', '4-59/15 * * * *',
                     'select public.sync_order_tracking_from_gestion()');

-- La planilla de Producción deja de ser fuente: sync_order_tracking_from_sheet NO se borra (la
-- llama un Apps Script desde afuera); si vuelve a escribir, el próximo ciclo lo corrige.
--
-- Backup previo (antes de aplicar):
--   create table zz_backups.bkp_order_tracking_20260925 as select * from public.order_tracking;
--   alter table zz_backups.bkp_order_tracking_20260925 enable row level security;
-- Chequeo: select status, count(*), max(updated_at) from public.order_tracking group by 1;
-- Rollback: select cron.unschedule('sync-order-tracking-gestion');
--           + restaurar desde el backup.
