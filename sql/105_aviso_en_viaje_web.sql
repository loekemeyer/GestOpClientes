-- 105 — (APLICADA 29/09 a PaginaLK) Aviso "salió en el camión" para pedidos WEB de reparto (Pablo, 29/09: "dale para
-- adelante").
--
-- Por qué así: Gestión no tiene un estado de "salió del depósito" para los pedidos web (sin_programar → programado →
-- pickeado → en_armado → armado → facturado → entregado), y "entregado" en reparto se marca AL DÍA SIGUIENTE a las 8
-- (20 de 21 pedidos web de reparto medidos el 29/09). trg_notify_despacho no sirve: mira la Programación de ISIS, donde
-- los pedidos web no están (sql/083).
-- Lo que sí se sabe es qué sale hoy: el pedido está FACTURADO (armado y con factura) y su fecha de entrega es HOY.
-- Entonces el día de la entrega, a las 9 y a las 11 (hora AR), a esos pedidos se les encola pedido_en_viaje
-- {{1}} fecha del pedido, {{2}} dirección de entrega (sucursal_entrega), una sola vez por pedido
-- (context 'en_viaje_web', ref_id = order_id). Sólo clientes agendados. Pasa por wa_outbox y la llave (D007).
-- Riesgo aceptado: si el camión no sale y nadie cambia la fecha en Gestión, el aviso dice que salió igual.
-- Rollback: select cron.unschedule('lk_aviso-en-viaje-web'); drop function public.wa_avisos_en_viaje_web();

create or replace function public.wa_avisos_en_viaje_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record;
begin
  for r in
    select o.id, bcw.whatsapp phone,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido,
           nullif(btrim(v.sucursal_entrega), '') direccion
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
      and coalesce(btrim(v.nombre_expreso), '') = ''
      and not exists (select 1 from wa_outbox w where w.context = 'en_viaje_web' and w.ref_id = o.id::text)
  loop
    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, 'pedido_en_viaje',
            jsonb_build_object('1', r.fecha_pedido, '2', coalesce(r.direccion, 'tu dirección de entrega')),
            'en_viaje_web', r.id::text);
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

-- 9:00 y 11:00 hora AR (12 y 14 UTC), lunes a sábado.
select cron.schedule('lk_aviso-en-viaje-web', '0 12,14 * * 1-6', $$ select public.wa_avisos_en_viaje_web(); $$);
