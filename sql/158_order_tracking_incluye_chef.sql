-- 158 — order_tracking también sincroniza CHEF desde Gestión (proyecto LK / PaginaLK)
-- Pedido de Pablo Olejavetzky (15/10/2026): vamos a enviar también las facturas de Chef, y el envío
-- se ancla en el despacho real (order_tracking.status = 'entregado'), no en la factura ni en
-- Facturacion_NP.fecha_salida (medido: fecha_salida es estimativa — coincide con la entrega real
-- sólo el 4,5% de las veces, +2,44 días de promedio, 18 vencidas sin entregar).
--
-- Problema: sync_order_tracking_from_gestion (sql/069) tenía hardcodeado `where g.empresa = 'lk'`
-- en las DOS ramas (update e insert), así que los pedidos de Chef NUNCA entraban a order_tracking.
-- La fuente virgilio.gv_pedido_web_estado_pagina SÍ tiene Chef con estado real (medido el 15/10:
-- 43 pedidos, 28 entregados, 1 recibido, 14 programados). Las filas Chef que había en order_tracking
-- eran basura vieja del feed de planilla (status '#value!' / 'recibido', congeladas desde el 21-24/09);
-- el UPDATE de esta función las pisa con el estado real en cuanto el order_id siga en la fuente.
--
-- Cambio: `where g.empresa = 'lk'`  →  `where g.empresa in ('lk','chef')` en las dos ramas.
-- Nada más de la función cambia. order_tracking.np_number = order_id (orders.id es secuencia global,
-- así que no hay colisión LK/Chef).
--
-- Principio D007 (vasectomía): al habilitar Chef, el trigger order_tracking_wa_notify va a encolar
-- también los avisos de despacho de Chef en wa_outbox, igual que con LK. NO sale nada: la llave
-- app_settings.wa_envio_automatico sigue en '0' y bot_customer_whatsapps controla a quién. No se
-- apaga ningún trigger: se alimenta la tabla de estado y queda en cola detrás de la llave.

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
     where g.empresa in ('lk','chef')
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
     where g.empresa in ('lk','chef')
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

-- Verificación (correr la sync y mirar que Chef entre con estado real):
--   select public.sync_order_tracking_from_gestion();
--   select np_number, status, fecha_entrega from public.order_tracking
--     where np_number in (select order_id::text from <chef order_ids>) order by updated_at desc;
-- Rollback: volver a la versión de sql/069 (las dos ramas con `where g.empresa = 'lk'`).
