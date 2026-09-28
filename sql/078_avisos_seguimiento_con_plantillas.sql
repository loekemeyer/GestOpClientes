-- 078 — (PENDIENTE de aplicar) Avisos de seguimiento con PLANTILLAS aprobadas en vez de texto libre (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09). Tarea Planify "Cablear avisos de pedido a plantillas WhatsApp".
--
-- Problema: trg_order_tracking_notify y trg_notify_despacho encolaban TEXTO LIBRE con "NP-1562" y fechas
-- con año. Fuera de la ventana de 24 h Meta lo rechaza (131047) y, cuando llega, se contradice con las
-- plantillas (28/09 a Thomy: "retirar el 30/09" y "entrega el 01/10/2026" del mismo pedido).
--
-- Ahora (siguen encolando en wa_outbox → pasan por la llave wa_envio_automatico, D007):
--   order_tracking pasa a 'programado' con fecha  → pedido_programado  {razón social, pedido del dd/mm, "miércoles 30/09"}
--                                                   (zona/retiro no se conoce para pedidos web: se asume entrega)
--   order_tracking cambia la fecha (sigue programado) → pedido_reprogramado {razón social, pedido del dd/mm, nueva fecha}
--   order_tracking pasa a 'entregado'             → NO se avisa (no hay plantilla aprobada de "entregado")
--   ppp_facturacion (despacho de un NP de Gestión)  → pedido_en_viaje {razón social, pedido del dd/mm, dirección}
--                                                   zona 'Retira' → pedido_listo_retirar {razón social, pedido del dd/mm}
-- Se dispara lk_outbox-flush en el acto (como el aviso de pedido recibido, sql/074).
-- Respaldo previo: zz_backups.bkp_avisos_texto_libre_20260928 (definiciones de las 2 funciones).

create table if not exists zz_backups.bkp_avisos_texto_libre_20260928 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('trg_order_tracking_notify', 'trg_notify_despacho');
alter table zz_backups.bkp_avisos_texto_libre_20260928 enable row level security;

-- "miércoles 30/09" (día + fecha sin año, como las plantillas).
create or replace function public.wa_fecha_con_dia(p date)
 returns text language sql immutable as $$
  select case when p is null then null else
    (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p)::int + 1]
    || ' ' || to_char(p, 'DD/MM') end;
$$;

create or replace function public.trg_order_tracking_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_fecha_pedido text;
  v_status_cambio boolean := (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status);
  v_tpl text;
  v_params jsonb;
  v_ctx text;
BEGIN
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.cod_cliente = NEW.cod_cliente
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  -- "pedido del dd/mm": fecha en que se hizo el pedido web (np_number = orders.id).
  SELECT to_char(o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM')
    INTO v_fecha_pedido
  FROM orders o WHERE o.id::text = NEW.np_number;

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_tpl := 'pedido_programado'; v_ctx := 'tracking_programado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_tpl := 'pedido_reprogramado'; v_ctx := 'tracking_fecha_cambio';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
  ELSE
    RETURN NEW;   -- 'entregado' y el resto: sin plantilla aprobada, no se avisa
  END IF;

  INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
  VALUES (v_phone, v_tpl, v_params, v_ctx, NEW.np_number);

  PERFORM net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 15000);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_order_tracking_notify falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;

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
  -- Dedup: ¿ya notificamos este NP?
  IF EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'despacho' AND ref_id = NEW.np) THEN
    RETURN NEW;
  END IF;

  SELECT bcw.whatsapp, prog.razon_social,
         CASE WHEN prog.fecha_recep <> '' THEN to_char(prog.fecha_recep::date, 'DD/MM') END,
         nullif(btrim(prog.direccion), ''), prog.zona
    INTO v_phone, v_customer_name, v_fecha_pedido, v_direccion, v_zona
  FROM ppp_programacion prog
  JOIN bot_customer_whatsapps bcw ON bcw.cod_cliente::text = prog.cod
  WHERE prog.np = NEW.np
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

-- Verificación:
--   select wa_fecha_con_dia('2026-09-30');   -- miércoles 30/09
--   (cambiar un order_tracking del cliente de prueba y mirar wa_outbox + wa_message_status)
-- Rollback: definiciones anteriores en zz_backups.bkp_avisos_texto_libre_20260928.
