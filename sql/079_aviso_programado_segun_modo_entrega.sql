-- 079 — (PENDIENTE de aplicar) Aviso de pedido programado según el MODO DE ENTREGA del pedido (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09): "eso es según el cliente". Corrige sql/078, que mandaba
-- pedido_programado ("lo entregamos el…") a todos: en los últimos 30 días fueron 109 reparto, 74 expreso
-- y 25 retiro (v_pedidos_web, un pedido por fila) → 99 de 208 recibían el texto equivocado.
--
-- Modo = el del pedido web (v_pedidos_web: dirección/expreso elegidos por el cliente, 5 ms por pedido):
--   zona 'Retira'           → pedido_programado_retira   ("va a estar listo para retirar el …")
--   con expreso             → pedido_programado_expreso  ("lo despachamos el … por <expreso>")
--   si no                   → pedido_programado          ("lo entregamos el …")
--   entregado + expreso     → pedido_en_viaje_expreso    ("ya salió hacia <expreso>"; sólo en UPDATE y una vez por pedido)
--   entregado reparto/retiro → sin aviso (no hay plantilla de "entregado" aprobada)
-- Cambio de fecha y despacho: igual que 078.

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
  v_modo text;
  v_expreso text;
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

  -- Modo de entrega de ESE pedido (lo eligió el cliente: su dirección de entrega / expreso).
  -- v_pedidos_web: zona 'Retira' → retira en el depósito; con expreso → expreso; si no → reparto.
  SELECT CASE WHEN v.zona_expreso ILIKE 'retira%' THEN 'retira'
              WHEN coalesce(btrim(v.nombre_expreso), '') <> '' THEN 'expreso'
              ELSE 'reparto' END,
         nullif(btrim(v.nombre_expreso), '')
    INTO v_modo, v_expreso
  FROM v_pedidos_web v WHERE v.order_id::text = NEW.np_number AND v.linea_rn = 1
  LIMIT 1;
  v_modo := coalesce(v_modo, 'reparto');

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_ctx := 'tracking_programado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
    IF v_modo = 'retira' THEN
      v_tpl := 'pedido_programado_retira';
    ELSIF v_modo = 'expreso' THEN
      v_tpl := 'pedido_programado_expreso';
      v_params := v_params || jsonb_build_object('4', v_expreso);
    ELSE
      v_tpl := 'pedido_programado';
    END IF;
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_tpl := 'pedido_reprogramado'; v_ctx := 'tracking_fecha_cambio';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
  ELSIF TG_OP = 'UPDATE' AND v_status_cambio AND NEW.status = 'entregado' AND v_modo = 'expreso'
        AND NOT EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'tracking_entregado' AND ref_id = NEW.np_number) THEN
    -- Entregado al expreso: "ya salió hacia <expreso>" (plantilla aprobada). Reparto y retiro en mano:
    -- sin aviso por ahora (no hay plantilla de "entregado" aprobada).
    v_tpl := 'pedido_en_viaje_expreso'; v_ctx := 'tracking_entregado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', v_expreso);
  ELSE
    RETURN NEW;
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

-- Verificación: select pg_get_functiondef('public.trg_order_tracking_notify'::regproc) ~ 'pedido_programado_expreso';
-- Rollback: la versión de sql/078 (o la de texto libre en zz_backups.bkp_avisos_texto_libre_20260928).
