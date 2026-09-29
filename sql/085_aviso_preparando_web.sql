-- 085 — Aviso "estamos preparando tu pedido" cuando el pedido web entra EN ARMADO (proyecto LK)
-- Pedido de Pablo Olejavetzky (29/09): "conectala en armado". pedido_preparando estaba aprobada en Meta y sin disparador.
--
-- wa_avisos_preparando_web(): pedidos web que en Gestión (virgilio.gv_pedido_web_estado_pagina, en vivo) están en
-- 'en_armado' (o ya 'armado', por si pasó entre dos vueltas del cron) desde hace menos de 2 días y tienen fecha de
-- salida → pedido_preparando {razón social, pedido del dd/mm, "miércoles 30/09"}, una vez por pedido (context
-- 'web_preparando'). Todos los modos. Sólo agendados; pasa por wa_outbox y la llave (D007).
-- Corre en el mismo cron que el aviso de retiro (lk_aviso-retiro-web, cada 10 min).
-- Texto aprobado en Meta: "Estamos preparando tu pedido del {{2}} en el depósito.\nSale el {{3}} de nuestro depósito."

create or replace function public.wa_avisos_preparando_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record;
begin
  for r in
    select o.id, bcw.whatsapp phone, c.business_name, e.fecha_entrega,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido
    from virgilio.gv_pedido_web_estado_pagina e
    join orders o on o.id = e.order_id
    join customers c on c.id = o.customer_id
    join lateral (select b.whatsapp from bot_customer_whatsapps b where b.customer_id = c.id
                  order by b.is_primary desc, b.created_at desc limit 1) bcw on true
    where e.empresa = 'lk' and e.estado in ('en_armado', 'armado') and e.estado_desde > now() - interval '2 days'
      and e.fecha_entrega is not null and o.sheets_sent
      and not exists (select 1 from wa_outbox w where w.context = 'web_preparando' and w.ref_id = o.id::text)
  loop
    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, 'pedido_preparando',
            jsonb_build_object('1', coalesce(nullif(btrim(r.business_name), ''), 'cliente'), '2', r.fecha_pedido,
                               '3', wa_fecha_con_dia(r.fecha_entrega)),
            'web_preparando', r.id::text);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_preparando_web falló: %', sqlerrm;
  return -1;
end $$;

select cron.unschedule('lk_aviso-retiro-web') where exists (select 1 from cron.job where jobname = 'lk_aviso-retiro-web');
select cron.schedule('lk_aviso-retiro-web', '*/10 * * * *',
  'select public.wa_avisos_preparando_web(); select public.wa_avisos_retiro_web();');
