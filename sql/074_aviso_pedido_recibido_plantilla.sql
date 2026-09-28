-- 074 — Aviso de pedido nuevo: plantilla pedido_recibido en vez de texto libre (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09).
--
-- Problema (prueba 28/09, NP-1562 a Thomy): trg_notify_order_created encolaba TEXTO LIBRE; Meta lo
-- acepta y a los 2 s lo rechaza con 131047 (fuera de la ventana de 24 h). A un cliente real casi
-- nunca le llegaría. La plantilla pedido_recibido (UTILITY, aprobada 28/09) llega siempre.
--
-- Ahora:
--   1. wa_metodo_pago_texto(): traduce orders.payment_method a texto para el cliente, SIN descuento
--      (Pablo: "eso lo ve cuando hace el pedido"). Probado contra los 17 valores reales de 60 días.
--   2. trg_notify_order_created encola template 'pedido_recibido' con {1 razón social, 2 fecha dd/mm,
--      3 total sin IVA, 4 método de pago} y dispara lk_outbox-flush en el acto (sale en segundos, no
--      esperando el cron de 2 min). Sigue pasando por la cola y la llave wa_envio_automatico (D007).
--   Destinatario: igual que antes (bot_customer_whatsapps del cliente, principal primero).

create or replace function public.wa_metodo_pago_texto(p text)
 returns text
 language sql
 immutable
as $function$
  select case
    when p is null or btrim(p) in ('', ':') or p ilike 'elegir%' or p ilike 'sin cotizador%'
         or p ~ '^(CHECK:|\d{3} - )' then 'a confirmar con tu vendedor'
    when p ilike 'prefiero no decidir%' then 'a definir'
    when p ~* '^(pago )?contado' then 'contado'
    when p ~* '^pago \d+-\d+ d' then 'a ' || substring(p from '\d+-\d+') || ' días'
    when p ~* '^pago \d+ d\S+ echeq' then 'e-cheq a ' || substring(p from '\d+') || ' días'
    else regexp_replace(lower(btrim(regexp_replace(p, ':.*$', ''))), '\mdias\M', 'días', 'g')
  end;
$function$;

create or replace function public.trg_notify_order_created()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
BEGIN
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.customer_id = NEW.customer_id
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;

  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
  VALUES (
    v_phone,
    'pedido_recibido',
    jsonb_build_object(
      '1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '3', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '4', wa_metodo_pago_texto(NEW.payment_method)),
    'order_created',
    NEW.id::text
  );

  -- Que salga ya: lk_outbox-flush vacía la cola (pasando por la llave). Si falla, lo toma el cron.
  PERFORM net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_notify_order_created falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;

-- Verificación:
--   select wa_metodo_pago_texto('Pago Contado: 25% Dto');   -- contado
--   (confirmar un pedido del cliente de prueba y mirar wa_outbox + wa_message_status)
-- Rollback: definición anterior guardada en zz_backups.bkp_trg_notify_order_created_20260928.
