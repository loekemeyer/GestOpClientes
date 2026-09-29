-- 108 — (APLICADA 29/09 a PaginaLK) pedido_recibido con el total con IVA (Pablo, 29/09).
-- Texto nuevo (pedido_recibido_v2, _shared/plantillas-meta.ts): "Recibimos tu pedido del {{2}} por {{3}}." con
-- {{3}} = "$896.668 ($741.048 + IVA)" (total × 1,21 y el neto). La plantilla vieja dice "por {{3}} + IVA.", así que
-- mientras la activa (app_settings.wa_plantillas_version) sea la vieja se sigue mandando sólo el neto; cuando
-- lk_promover-plantillas pasa a la v2, el disparador arma el texto nuevo solo. Misma cantidad de variables (5).
-- IVA 21 %: todos los artículos de la web lo son (bazar/cocina). Rollback: volver a la definición de sql/104.

create or replace function public.trg_notify_order_created()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_est record;
  v_neto text;
  v_total text;
BEGIN
  IF NOT coalesce(NEW.sheets_sent, false) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.sheets_sent, false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'order_created' AND ref_id = NEW.id::text) THEN RETURN NEW; END IF;

  SELECT * INTO v_est FROM wa_fecha_estimada_calc(NEW.id);
  IF v_est.fecha IS NOT NULL THEN
    INSERT INTO wa_fecha_estimada (order_id, modo, fecha, regla, dias, muestra, texto)
    VALUES (NEW.id, v_est.modo, v_est.fecha, v_est.regla, v_est.dias, v_est.muestra, v_est.texto)
    ON CONFLICT (order_id) DO NOTHING;
  END IF;

  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.customer_id = NEW.customer_id
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  v_neto := '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.');
  v_total := v_neto;
  -- sql/108: con la v2 activa, "$896.668 ($741.048 + IVA)".
  IF coalesce((SELECT (value::jsonb) -> 'pedido_recibido' ->> 'activa' FROM app_settings
               WHERE key = 'wa_plantillas_version'), 'pedido_recibido') <> 'pedido_recibido' THEN
    v_total := '$' || replace(to_char(round(coalesce(NEW.total, 0) * 1.21), 'FM999G999G999'), ',', '.')
               || ' (' || v_neto || ' + IVA)';
  END IF;

  INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
  VALUES (
    v_phone,
    'pedido_recibido',
    jsonb_build_object(
      '1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '3', v_total,
      '4', wa_metodo_pago_texto(NEW.payment_method),
      '5', coalesce(v_est.texto, 'a confirmar')),  -- sql/104: con razón social (primer mensaje)
    'order_created',
    NEW.id::text
  );

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
