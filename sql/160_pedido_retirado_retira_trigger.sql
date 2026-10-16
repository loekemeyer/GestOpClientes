-- 160 — (APLICADA 16/10 a PaginaLK) pedido_retirado: el trigger order_tracking ahora avisa también en modo RETIRA.
-- Antes la rama 'entregado' excluía retira (v_modo IN ('expreso','reparto')), así que cuando un cliente retiraba y se
-- marcaba el remito, prendía order_tracking.status='entregado' pero el bot no mandaba nada. Ahora incluye 'retira' y
-- encola pedido_retirado ({{1}} = fecha del pedido). Reparto (pedido_entregado) y expreso (pedido_en_viaje_expreso)
-- quedan EXACTAMENTE igual.
--
-- La señal del retiro NO es la factura ni la fecha: es la marca del remito en Virgilio. En
-- Registros_Produccion_Virgilio el evento es opcion='CRN' ("Control Remito NP", variante "Retira (entregado en
-- depósito)"), que es lo que la pantalla Recepción Remitos (RR) graba al tildar CONTROLADO + Terminé. Eso prende
-- virgilio.gv_pedido_web_estado_pagina.entregado, que sync_order_tracking_from_gestion (cron 15 min) copia a
-- order_tracking.status='entregado' y dispara este trigger. Verificado 16/10 sobre 3 retira con CRN "entregado en
-- depósito" (orders 1656/1658/1666): entregado=true con timestamps reales.
--
-- Vasectomía: NO contacta a nadie hasta que app_settings.wa_envio_automatico pase a '1'. Encola en wa_outbox y sale por
-- bot_flush_outbox/wa_puede_enviar, acotado a wa_envio_contactos mientras la llave esté en 'prueba'.
--
-- Pedido de Pablo Olejavetzky (16/10). pedido_retirado ya aprobada por Meta (16/10, id 2529181834243049).
-- Rollback: zz_backups.bkp_tracking_notify_20261016 (definición anterior).

CREATE OR REPLACE FUNCTION public.trg_order_tracking_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_dir text;
BEGIN
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.cod_cliente = NEW.cod_cliente
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  SELECT to_char(o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM')
    INTO v_fecha_pedido
  FROM orders o WHERE o.id::text = NEW.np_number;

  SELECT CASE WHEN v.zona_expreso ILIKE 'retira%' THEN 'retira'
              WHEN coalesce(btrim(v.nombre_expreso), '') <> '' THEN 'expreso'
              ELSE 'reparto' END,
         nullif(btrim(v.nombre_expreso), ''), nullif(btrim(v.sucursal_entrega), '')
    INTO v_modo, v_expreso, v_dir
  FROM v_pedidos_web v WHERE v.order_id::text = NEW.np_number AND v.linea_rn = 1
  LIMIT 1;
  v_modo := coalesce(v_modo, 'reparto');

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_ctx := 'tracking_programado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
    IF v_modo = 'retira' THEN
      v_tpl := 'pedido_programado_retira';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092
    ELSIF v_modo = 'expreso' THEN
      v_tpl := 'pedido_programado_expreso';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega),
        '3', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));
    ELSE
      v_tpl := 'pedido_programado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega),
        '3', coalesce(v_dir, 'tu dirección de entrega'));
    END IF;
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_tpl := 'pedido_reprogramado'; v_ctx := 'tracking_fecha_cambio';
    v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092
  ELSIF TG_OP = 'UPDATE' AND v_status_cambio AND NEW.status = 'entregado' AND v_modo IN ('expreso', 'reparto', 'retira')
        AND NOT EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'tracking_entregado' AND ref_id = NEW.np_number) THEN
    v_ctx := 'tracking_entregado';
    IF v_modo = 'expreso' THEN
      v_tpl := 'pedido_en_viaje_expreso';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'),
        '2', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));  -- sql/094
    ELSIF v_modo = 'retira' THEN
      v_tpl := 'pedido_retirado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));  -- sql/160
    ELSE
      v_tpl := 'pedido_entregado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));  -- sql/094
    END IF;
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
