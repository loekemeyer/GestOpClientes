-- 110 — (APLICADA 30/09 a PaginaLK) "Listo para retirar" con fecha límite y sin saludo (Pablo, 30/09, auditoría).
-- Texto nuevo (pedido_listo_retirar_v2, _shared/plantillas-meta.ts): "Tu pedido del {{1}} está listo para retirar …
-- Retiralo hasta {{2}}: al día siguiente se desarma." con {{1}} = fecha del pedido y {{2}} = "el jueves 02/10" (fecha de
-- entrega acordada en Gestión) o "la fecha acordada" si no hay. La v1 aprobada en Meta es {{1}} razón social,
-- {{2}} fecha del pedido: mientras la activa (app_settings.wa_plantillas_version) sea la v1 se sigue mandando eso, y
-- cuando lk_promover-plantillas pasa a la v2 el cron arma las variables nuevas solo. Mismo patrón que sql/108.
-- (trg_notify_despacho también usa esta plantilla con {razón social, fecha}, pero su disparador se borró en sql/109.)
-- Rollback: volver a la definición de sql/083.

create or replace function public.wa_avisos_retiro_web()
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_n integer := 0; r record; v_nueva boolean;
begin
  v_nueva := coalesce((select (value::jsonb) -> 'pedido_listo_retirar' ->> 'activa' from app_settings
                       where key = 'wa_plantillas_version'), 'pedido_listo_retirar') <> 'pedido_listo_retirar';
  for r in
    select o.id, bcw.whatsapp phone, c.business_name, e.fecha_entrega,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido
    from virgilio.gv_pedido_web_estado_pagina e
    join orders o on o.id = e.order_id
    join customers c on c.id = o.customer_id
    join lateral (select b.whatsapp from bot_customer_whatsapps b where b.customer_id = c.id
                  order by b.is_primary desc, b.created_at desc limit 1) bcw on true
    join v_pedidos_web v on v.order_id = o.id and v.linea_rn = 1
    where e.empresa = 'lk' and e.estado = 'facturado' and not coalesce(e.entregado, false)
      and o.sheets_sent and o.created_at > now() - interval '30 days'
      and v.zona_expreso ilike 'retira%'
      and not exists (select 1 from wa_outbox w where w.context = 'retiro_listo' and w.ref_id = o.id::text)
  loop
    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, 'pedido_listo_retirar',
            case when v_nueva
              then jsonb_build_object('1', r.fecha_pedido,
                     '2', coalesce('el ' || wa_fecha_con_dia(r.fecha_entrega::date), 'la fecha acordada'))
              else jsonb_build_object('1', coalesce(nullif(btrim(r.business_name), ''), 'cliente'), '2', r.fecha_pedido)
            end,
            'retiro_listo', r.id::text);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_retiro_web falló: %', sqlerrm;
  return -1;
end $function$;
