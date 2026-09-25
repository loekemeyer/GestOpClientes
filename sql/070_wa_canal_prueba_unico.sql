-- 070 — Un solo corte, un solo canal de prueba (proyecto LK kwkclwhmoygunqmlegrg)
-- Luis, 2026-09-25: "tiene que quedar un único canal abierto para testeo (inbound y outbound):
-- el celu de alguien en whitelist para que le lleguen comunicaciones automáticas y que cuando le
-- escriba al bot/agente pueda conversar". Principio D007 (vasectomía).
-- ESTADO: APLICADO el 2026-09-25 con el "sí a todo" de Luis.
--
-- 1) wa_puede_enviar(phone): LA única decisión de "¿este mensaje puede salir?". La usan
--    bot_flush_outbox, notify-tracking-status, las respuestas del webhook y toda edge que le hable
--    a Meta (_shared/wa-api.ts y las deployadas sueltas). Cambiar la política = cambiar esto.
--      wa_envio_automatico = '1'      → sí, a cualquiera
--                          = 'prueba' → sólo a números de wa_envio_contactos
--                          = '0'/nada → no
-- 2) Canal de prueba = Thomy: está en wa_envio_contactos (inbound: el webhook le contesta) y
--    queda asociado al CLIENTE DE PRUEBA LK 99862 (Luiggy y Luiggy) en bot_customer_whatsapps,
--    así los avisos automáticos de pedidos de ese cliente le llegan a él y a nadie más.
-- 3) Aviso de CAMBIO DE FECHA en order_tracking (antes sólo avisaba por cambio de estado, y un
--    cambio sólo de fecha re-mandaba "programado").
-- 4) La llave pasa a 'prueba'.

create or replace function public.wa_puede_enviar(p_phone text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select case coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0')
           when '1' then true
           when 'prueba' then exists (
             select 1 from wa_envio_contactos c
              where regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
                and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> '')
           else false
         end;
$function$;
revoke all on function public.wa_puede_enviar(text) from public, anon, authenticated;
grant execute on function public.wa_puede_enviar(text) to service_role;

create or replace function public.bot_flush_outbox(p_limit integer default 20)
 returns table(id bigint, phone text, body text, template_name text, template_params jsonb)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_modo text := coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0');
begin
  -- Llave general (068/070): apagada → no despacha nada, la cola queda como está.
  if v_modo not in ('prueba', '1') then
    return;
  end if;

  -- Lo que no puede salir (wa_puede_enviar) se retiene y no se reintenta.
  update wa_outbox o
     set status = 'held_no_whitelist'
   where o.status = 'pending'
     and not wa_puede_enviar(o.phone);

  return query
  with batch as (
    select o.id
    from wa_outbox o
    where o.status = 'pending'
      and o.attempts < o.max_attempts
    order by o.created_at
    limit p_limit
    for update skip locked
  )
  update wa_outbox o
  set status = 'sending', attempts = attempts + 1
  from batch b
  where o.id = b.id
  returning o.id, o.phone, o.body, o.template_name, o.template_params;
end;
$function$;

create or replace function public.trg_order_tracking_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_body text;
  v_status_cambio boolean := (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status);
BEGIN
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.cod_cliente = NEW.cod_cliente
    AND bcw.is_primary = true
  LIMIT 1;

  IF v_phone IS NULL THEN
    SELECT bcw.whatsapp, c.business_name
      INTO v_phone, v_customer_name
    FROM bot_customer_whatsapps bcw
    JOIN customers c ON c.id = bcw.customer_id
    WHERE bcw.cod_cliente = NEW.cod_cliente
    LIMIT 1;
  END IF;

  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_body := E'\U0001F69A *Entrega programada*\n\nHola ' || COALESCE(v_customer_name, '') ||
      E', tu pedido *NP-' || NEW.np_number ||
      E'* está programado para entrega el *' || TO_CHAR(NEW.fecha_entrega, 'DD/MM/YYYY') || E'*.\n\n¡Te esperamos! \U0001F4E6';
    INSERT INTO wa_outbox (phone, body, context, ref_id)
    VALUES (v_phone, v_body, 'tracking_programado', NEW.np_number);

  ELSIF v_status_cambio AND NEW.status = 'entregado' THEN
    v_body := E'✅ *Pedido entregado*\n\nHola ' || COALESCE(v_customer_name, '') ||
      E', tu pedido *NP-' || NEW.np_number || E'* fue entregado.\n\n¡Gracias por tu compra! \U0001F64F';
    INSERT INTO wa_outbox (phone, body, context, ref_id)
    VALUES (v_phone, v_body, 'tracking_entregado', NEW.np_number);

  -- 070: mismo estado 'programado', otra fecha → aviso de cambio de fecha.
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_body := E'\U0001F4C5 *Cambio de fecha de entrega*\n\nHola ' || COALESCE(v_customer_name, '') ||
      E', tu pedido *NP-' || NEW.np_number || E'* ahora se entrega el *' ||
      TO_CHAR(NEW.fecha_entrega, 'DD/MM/YYYY') || E'* (antes: ' || TO_CHAR(OLD.fecha_entrega, 'DD/MM/YYYY') || E').';
    INSERT INTO wa_outbox (phone, body, context, ref_id)
    VALUES (v_phone, v_body, 'tracking_fecha_cambio', NEW.np_number);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_order_tracking_notify falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;

drop trigger if exists order_tracking_wa_notify on public.order_tracking;
create trigger order_tracking_wa_notify
  after insert or update of status, fecha_entrega on public.order_tracking
  for each row execute function public.trg_order_tracking_notify();

-- Canal de prueba: Thomy ↔ cliente de prueba LK 99862.
insert into public.bot_customer_whatsapps (customer_id, whatsapp, is_primary, empresa, cod_cliente)
select c.id, '5491162521635', true, 'LK', 99862 from public.customers c
 where c.cod_cliente = 99862
   and not exists (select 1 from public.bot_customer_whatsapps b where b.cod_cliente = 99862);

update public.app_settings set value = 'prueba' where key = 'wa_envio_automatico';

-- Cron del feed de 069 (se agenda recién acá, con el aviso de fecha ya puesto).
select cron.schedule('sync-order-tracking-gestion', '4-59/15 * * * *',
                     'select public.sync_order_tracking_from_gestion()');

-- Rollback:
--   update app_settings set value='0' where key='wa_envio_automatico';        -- corta todo
--   delete from bot_customer_whatsapps where cod_cliente = 99862;
--   select cron.unschedule('sync-order-tracking-gestion');
--   trigger viejo: after insert or update of status (función en 006/068 historial).
