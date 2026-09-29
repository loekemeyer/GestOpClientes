-- 106 — (APLICADA 29/09 a PaginaLK) "Entregado al expreso" el día de la entrega (Pablo, 29/09).
-- Antes salía cuando Gestión marcaba el pedido "entregado", que es al día siguiente a las 8 (23 de 27 pedidos web por
-- expreso medidos el 29/09). Ahora wa_avisos_en_viaje_web (sql/105, cron 9 y 11 h AR) también toma los pedidos web por
-- expreso facturados con fecha de entrega hoy y encola pedido_en_viaje_expreso {fecha del pedido, expreso sin
-- "Expreso"}. Usa context 'tracking_entregado' (el mismo de trg_order_tracking_notify), así cuando al día siguiente
-- se marca "entregado" el trigger ve que ya salió y no lo repite. Si ese día no llegó a estar facturado, el trigger
-- lo manda como antes (al marcarse entregado).
-- Rollback: volver a la definición de sql/105.

create or replace function public.wa_avisos_en_viaje_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record;
begin
  for r in
    select o.id, bcw.whatsapp phone,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido,
           nullif(btrim(v.sucursal_entrega), '') direccion,
           nullif(btrim(v.nombre_expreso), '') expreso
    from virgilio.gv_pedido_web_estado_pagina e
    join orders o on o.id = e.order_id
    join customers c on c.id = o.customer_id
    join lateral (select b.whatsapp from bot_customer_whatsapps b where b.customer_id = c.id
                  order by b.is_primary desc, b.created_at desc limit 1) bcw on true
    join v_pedidos_web v on v.order_id = o.id and v.linea_rn = 1
    where e.empresa = 'lk' and e.estado = 'facturado' and not coalesce(e.entregado, false)
      and e.fecha_entrega = (now() at time zone 'America/Argentina/Buenos_Aires')::date
      and o.sheets_sent and o.created_at > now() - interval '60 days'
      and coalesce(v.zona_expreso, '') not ilike 'retira%'
      and not exists (select 1 from wa_outbox w where w.ref_id = o.id::text
                        and w.context in ('en_viaje_web', 'tracking_entregado'))
  loop
    if r.expreso is not null then
      insert into wa_outbox (phone, template_name, template_params, context, ref_id)
      values (r.phone, 'pedido_en_viaje_expreso',
              jsonb_build_object('1', r.fecha_pedido, '2', regexp_replace(r.expreso, '^\s*expreso\s+', '', 'i')),
              'tracking_entregado', r.id::text);
    else
      insert into wa_outbox (phone, template_name, template_params, context, ref_id)
      values (r.phone, 'pedido_en_viaje',
              jsonb_build_object('1', r.fecha_pedido, '2', coalesce(r.direccion, 'tu dirección de entrega')),
              'en_viaje_web', r.id::text);
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_en_viaje_web falló: %', sqlerrm;
  return -1;
end $$;
