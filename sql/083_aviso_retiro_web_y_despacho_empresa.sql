-- 083 — Aviso "listo para retirar" para pedidos WEB + el aviso de despacho filtra empresa (proyecto LK)
-- Pedido de Pablo Olejavetzky (29/09). Auditoría: problemas 613 (web sin aviso de despacho/retiro) y 615 (sin empresa).
--
-- Por qué: trg_notify_despacho (sql/078) mira ppp_programacion, que es una FOTO diaria (sincronizar_ppp, 10:00,
-- borra y recarga) de la Programación de ISIS: los NP web (LK xxxx) nunca están ahí, así que a un retiro web jamás
-- le llegaba pedido_listo_retirar. El estado en vivo de cada pedido web está en Gestión:
-- virgilio.gv_pedido_web_estado_pagina (FDW; sin_programar → programado → pickeado → en_armado → armado →
-- facturado → entregado).
--
-- Ahora:
--   1. wa_avisos_retiro_web(): pedidos web de retiro (v_pedidos_web) de los últimos 30 días que llegaron a
--      'facturado' (listo: armado y con factura) y todavía no se retiraron → encola pedido_listo_retirar
--      {razón social, pedido del dd/mm}, una sola vez por pedido (context 'retiro_listo', ref_id = order_id).
--      Sólo clientes agendados (bot_customer_whatsapps). Pasa por wa_outbox y la llave (D007).
--      Cron cada 10 minutos.
--   2. trg_notify_despacho: sólo NP de LK (antes un NP de Chef con el mismo código de cliente avisaba a LK).
-- Rollback: zz_backups.bkp_trg_notify_despacho_20260929; cron.unschedule('lk_aviso-retiro-web').

create table if not exists zz_backups.bkp_trg_notify_despacho_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'trg_notify_despacho';
alter table zz_backups.bkp_trg_notify_despacho_20260929 enable row level security;

create or replace function public.wa_avisos_retiro_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record;
begin
  for r in
    select o.id, bcw.whatsapp phone, c.business_name,
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
            jsonb_build_object('1', coalesce(nullif(btrim(r.business_name), ''), 'cliente'), '2', r.fecha_pedido),
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
end $$;

create or replace function public.trg_notify_despacho()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_fecha_pedido text;
  v_direccion text;
  v_zona text;
BEGIN
  IF EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'despacho' AND ref_id = NEW.np) THEN
    RETURN NEW;
  END IF;

  SELECT bcw.whatsapp, prog.razon_social,
         CASE WHEN prog.fecha_recep <> '' THEN to_char(prog.fecha_recep::date, 'DD/MM') END,
         nullif(btrim(prog.direccion), ''), prog.zona
    INTO v_phone, v_customer_name, v_fecha_pedido, v_direccion, v_zona
  FROM ppp_programacion prog
  JOIN bot_customer_whatsapps bcw ON bcw.cod_cliente::text = prog.cod
  WHERE prog.np = NEW.np AND prog.empresa = 'lk'
  ORDER BY bcw.is_primary DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  IF v_zona ILIKE 'retira%' THEN
    INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
    VALUES (v_phone, 'pedido_listo_retirar',
      jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'), '2', coalesce(v_fecha_pedido, 'reciente')),
      'despacho', NEW.np);
  ELSE
    INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
    VALUES (v_phone, 'pedido_en_viaje',
      jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'), '2', coalesce(v_fecha_pedido, 'reciente'),
        '3', coalesce(v_direccion, 'tu dirección')),
      'despacho', NEW.np);
  END IF;

  PERFORM net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 15000);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_notify_despacho falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;

select cron.unschedule('lk_aviso-retiro-web') where exists (select 1 from cron.job where jobname = 'lk_aviso-retiro-web');
select cron.schedule('lk_aviso-retiro-web', '*/10 * * * *', 'select public.wa_avisos_retiro_web();');

-- Verificación (sólo lectura): pedidos que avisaría ahora
--   select e.order_id, e.estado from virgilio.gv_pedido_web_estado_pagina e where e.empresa='lk' and e.estado='facturado';
