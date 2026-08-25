-- Notificaciones proactivas por WhatsApp
-- Patrón outbox: triggers insertan en cola → pg_cron flush → Meta API
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- ════════════════════════════════════════════════════════════════════
-- 1. Tabla wa_outbox (cola de mensajes salientes)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wa_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone           text NOT NULL,
  body            text,                     -- texto libre (null si es template)
  template_name   text,                     -- nombre template Meta (null si es texto)
  template_params jsonb,                    -- parámetros del template
  status          text NOT NULL DEFAULT 'pending',  -- pending / sent / failed
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  created_at      timestamptz DEFAULT now(),
  sent_at         timestamptz,
  error           text,
  context         text,                     -- origen: order_created / tracking_programado / tracking_entregado
  ref_id          text                      -- referencia: order_id o np_number
);

CREATE INDEX IF NOT EXISTS idx_wa_outbox_pending ON wa_outbox(status, created_at)
  WHERE status = 'pending';

-- RLS
ALTER TABLE wa_outbox ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'wa_outbox' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON wa_outbox
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════
-- 2. Trigger: pedido creado → encolar notificación
-- ════════════════════════════════════════════════════════════════════
-- Reemplaza el trigger existente que usaba pg_net POST
-- Ahora solo inserta en wa_outbox (más robusto, con reintentos)

CREATE OR REPLACE FUNCTION trg_notify_order_created()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_phone text;
  v_customer_name text;
BEGIN
  -- Buscar teléfono principal del cliente en bot_customer_whatsapps
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.customer_id = NEW.customer_id
    AND bcw.is_primary = true
  LIMIT 1;

  -- Si no tiene teléfono, intentar cualquier teléfono del cliente
  IF v_phone IS NULL THEN
    SELECT bcw.whatsapp, c.business_name
      INTO v_phone, v_customer_name
    FROM bot_customer_whatsapps bcw
    JOIN customers c ON c.id = bcw.customer_id
    WHERE bcw.customer_id = NEW.customer_id
    LIMIT 1;
  END IF;

  -- Si no tiene teléfono vinculado, salir silenciosamente
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- Encolar notificación
  INSERT INTO wa_outbox (phone, body, context, ref_id)
  VALUES (
    v_phone,
    '✅ *Pedido recibido*' || chr(10) || chr(10) ||
    'Hola ' || COALESCE(v_customer_name, '') || ', tu pedido *NP-' || NEW.id || '* fue registrado.' || chr(10) ||
    'Total: $' || REPLACE(TO_CHAR(COALESCE(NEW.total, 0), 'FM999G999G999'), ',', '.') || chr(10) || chr(10) ||
    'Te avisamos cuando se programe la entrega. 🚚',
    'order_created',
    NEW.id::text
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_notify_order_created falló: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- El trigger orders_notify_whatsapp ya existe, no hace falta recrearlo
-- (ya apunta a trg_notify_order_created, que ahora usa outbox)


-- ════════════════════════════════════════════════════════════════════
-- 3. Trigger: tracking cambia → encolar notificación
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_order_tracking_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_phone text;
  v_customer_name text;
  v_body text;
BEGIN
  -- Buscar teléfono del cliente por cod_cliente
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.cod_cliente = NEW.cod_cliente
    AND bcw.is_primary = true
  LIMIT 1;

  -- Fallback: cualquier teléfono
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

  -- Solo notificar en ciertos estados
  IF NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_body := '🚚 *Entrega programada*' || chr(10) || chr(10) ||
      'Hola ' || COALESCE(v_customer_name, '') || ', tu pedido *NP-' || NEW.np_number || '* ' ||
      'está programado para entrega el *' || TO_CHAR(NEW.fecha_entrega, 'DD/MM/YYYY') || '*.' || chr(10) || chr(10) ||
      '¡Te esperamos! 📦';

    INSERT INTO wa_outbox (phone, body, context, ref_id)
    VALUES (v_phone, v_body, 'tracking_programado', NEW.np_number);

  ELSIF NEW.status = 'entregado' THEN
    v_body := '✅ *Pedido entregado*' || chr(10) || chr(10) ||
      'Hola ' || COALESCE(v_customer_name, '') || ', tu pedido *NP-' || NEW.np_number || '* fue entregado.' || chr(10) || chr(10) ||
      '¡Gracias por tu compra! 🙏';

    INSERT INTO wa_outbox (phone, body, context, ref_id)
    VALUES (v_phone, v_body, 'tracking_entregado', NEW.np_number);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_order_tracking_notify falló: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- Crear trigger en order_tracking (solo si no existe)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'order_tracking_wa_notify'
  ) THEN
    CREATE TRIGGER order_tracking_wa_notify
      AFTER INSERT OR UPDATE OF status ON order_tracking
      FOR EACH ROW EXECUTE FUNCTION trg_order_tracking_notify();
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════
-- 4. RPC: bot_flush_outbox — devuelve mensajes pendientes para enviar
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION bot_flush_outbox(p_limit int DEFAULT 20)
RETURNS TABLE(
  id bigint,
  phone text,
  body text,
  template_name text,
  template_params jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Marcar los pendientes como 'sending' y devolverlos
  RETURN QUERY
  WITH batch AS (
    SELECT o.id
    FROM wa_outbox o
    WHERE o.status = 'pending'
      AND o.attempts < o.max_attempts
    ORDER BY o.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE wa_outbox o
  SET status = 'sending', attempts = attempts + 1
  FROM batch b
  WHERE o.id = b.id
  RETURNING o.id, o.phone, o.body, o.template_name, o.template_params;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 5. RPC: bot_outbox_mark — marcar resultado de envío
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION bot_outbox_mark(
  p_id bigint,
  p_status text,       -- 'sent' o 'failed'
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE wa_outbox
  SET status = p_status,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      error = COALESCE(p_error, error)
  WHERE id = p_id;

  -- Si falló y todavía tiene reintentos, volver a pending
  UPDATE wa_outbox
  SET status = 'pending'
  WHERE id = p_id
    AND status = 'failed'
    AND attempts < max_attempts;
END;
$$;
