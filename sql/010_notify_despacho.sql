-- Trigger: notificación proactiva de despacho vía WhatsApp
-- Cuando un pedido se factura (INSERT en ppp_facturacion), se envía
-- notificación "Tu pedido está en camino" al cliente vía wa_outbox.
-- Dedup: un solo aviso por NP aunque sincronizar_ppp() haga DELETE+INSERT diario.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- Función trigger
CREATE OR REPLACE FUNCTION trg_notify_despacho()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_phone text;
  v_customer_name text;
  v_fecha_pedido text;
  v_fecha_entrega text;
  v_body text;
BEGIN
  -- Dedup: ¿ya notificamos este NP?
  IF EXISTS (
    SELECT 1 FROM wa_outbox WHERE context = 'despacho' AND ref_id = NEW.np
  ) THEN
    RETURN NEW;
  END IF;

  -- Buscar cliente y teléfono via ppp_programacion → bot_customer_whatsapps
  SELECT bcw.whatsapp, prog.razon_social,
         CASE WHEN prog.fecha_recep <> '' THEN TO_CHAR(prog.fecha_recep::date, 'DD/MM/YYYY') END,
         CASE WHEN prog.fecha_entrega <> '' THEN TO_CHAR(prog.fecha_entrega::date, 'DD/MM/YYYY') END
    INTO v_phone, v_customer_name, v_fecha_pedido, v_fecha_entrega
  FROM ppp_programacion prog
  JOIN bot_customer_whatsapps bcw ON bcw.cod_cliente::text = prog.cod AND bcw.is_primary = true
  WHERE prog.np = NEW.np
  LIMIT 1;

  -- Fallback: cualquier teléfono del cliente
  IF v_phone IS NULL THEN
    SELECT bcw.whatsapp, prog.razon_social,
           CASE WHEN prog.fecha_recep <> '' THEN TO_CHAR(prog.fecha_recep::date, 'DD/MM/YYYY') END,
           CASE WHEN prog.fecha_entrega <> '' THEN TO_CHAR(prog.fecha_entrega::date, 'DD/MM/YYYY') END
      INTO v_phone, v_customer_name, v_fecha_pedido, v_fecha_entrega
    FROM ppp_programacion prog
    JOIN bot_customer_whatsapps bcw ON bcw.cod_cliente::text = prog.cod
    WHERE prog.np = NEW.np
    LIMIT 1;
  END IF;

  -- Sin teléfono → salir
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- Construir mensaje
  v_body := '🚚 *Tu pedido está en camino*' || chr(10) || chr(10) ||
    'Hola ' || COALESCE(v_customer_name, '');

  IF v_fecha_pedido IS NOT NULL THEN
    v_body := v_body || ', tu pedido del *' || v_fecha_pedido || '*';
  ELSE
    v_body := v_body || ', tu pedido';
  END IF;

  v_body := v_body || ' acaba de salir.';

  IF v_fecha_entrega IS NOT NULL THEN
    v_body := v_body || chr(10) || 'Entrega estimada: *' || v_fecha_entrega || '*';
  END IF;

  v_body := v_body || chr(10) || chr(10) || '¡Te esperamos! 📦';

  -- Encolar notificación
  INSERT INTO wa_outbox (phone, body, context, ref_id)
  VALUES (v_phone, v_body, 'despacho', NEW.np);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_notify_despacho falló: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- Trigger en ppp_facturacion
CREATE TRIGGER ppp_facturacion_wa_notify
  AFTER INSERT ON ppp_facturacion
  FOR EACH ROW
  EXECUTE FUNCTION trg_notify_despacho();
