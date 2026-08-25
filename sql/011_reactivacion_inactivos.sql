-- Reactivación de clientes inactivos vía WhatsApp
-- El bot contacta automáticamente a clientes que no compran hace X meses.
-- Usa la misma lógica de inactividad que get_ranking_inactivos (canon groups,
-- excluidos, sales_lines + orders).
-- Teléfonos desde wa_clientes_telefono (sync de virgilio.whatsapp_clientes).
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
--
-- Prerequisitos (aplicados por separado):
--   1. Foreign table virgilio.whatsapp_clientes en PaginaLK
--   2. GRANT SELECT + RLS policy en Virgilio para lk_ppp_reader
--   3. wa_clientes_telefono agregada a sincronizar_ppp()

-- ═══════════════════════════════════════════════════════════════════════
-- Tabla local: teléfonos de clientes (sync de Virgilio)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.wa_clientes_telefono (
  cod_cliente text NOT NULL PRIMARY KEY,
  telefono text NOT NULL,
  actualizado timestamptz
);

COMMENT ON TABLE wa_clientes_telefono
  IS 'Sync de virgilio.whatsapp_clientes — teléfonos de clientes para notificaciones proactivas';

-- ═══════════════════════════════════════════════════════════════════════
-- Configuración (single-row)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bot_reactivacion_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  meses_inactividad int NOT NULL DEFAULT 6,
  cooldown_dias int NOT NULL DEFAULT 99999,       -- contacto único por defecto
  max_por_dia int NOT NULL DEFAULT 5,
  mensaje_template text NOT NULL DEFAULT '',
  template_name text,                             -- template Meta (fuera de ventana 24h)
  updated_at timestamptz DEFAULT now()
);

COMMENT ON TABLE bot_reactivacion_config
  IS 'Configuración de reactivación de clientes inactivos (single-row)';

INSERT INTO bot_reactivacion_config (id, enabled, meses_inactividad, cooldown_dias, max_por_dia, mensaje_template)
VALUES (1, false, 6, 99999, 5,
  E'¡Hola {nombre}! 👋\n\nSoy el asistente de *Loekemeyer*. Hace un tiempo que no nos visitás y queríamos saber cómo estás.\n\n🆕 Tenemos *novedades y productos nuevos* que te pueden interesar.\n📦 Podés hacer tu pedido directamente por acá.\n📋 ¿Querés que te mande el *catálogo actualizado*?\n\n¡Esperamos tu mensaje! 😊')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Log de contactos realizados
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bot_reactivacion_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cod_cliente text NOT NULL,
  telefono text NOT NULL,
  business_name text,
  contacted_at timestamptz NOT NULL DEFAULT now(),
  outbox_id bigint,
  responded boolean NOT NULL DEFAULT false,
  responded_at timestamptz,
  UNIQUE (cod_cliente, contacted_at)
);

CREATE INDEX IF NOT EXISTS idx_react_log_cod ON bot_reactivacion_log (cod_cliente);
CREATE INDEX IF NOT EXISTS idx_react_log_date ON bot_reactivacion_log (contacted_at DESC);

COMMENT ON TABLE bot_reactivacion_log
  IS 'Historial de contactos de reactivación — quién fue contactado y cuándo';

-- ═══════════════════════════════════════════════════════════════════════
-- RPC: detectar inactivos y encolar mensaje de reactivación
-- ═══════════════════════════════════════════════════════════════════════
-- Misma lógica de inactividad que get_ranking_inactivos:
--   - Combina sales_lines (ERP) + orders (web) para última compra
--   - Respeta customer_grupos (canonicalización)
--   - Excluye ranking_inactivos_excluidos + lk_ch_excluidos_cache
--   - Dedup via bot_reactivacion_log (cooldown configurable)
-- Encola en wa_outbox (patrón outbox existente, flush cada 2 min)

CREATE OR REPLACE FUNCTION bot_reactivar_inactivos()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  cfg record;
  r record;
  v_body text;
  v_phone_clean text;
  v_outbox_id bigint;
  n_enqueued int := 0;
BEGIN
  -- Leer config
  SELECT * INTO cfg FROM bot_reactivacion_config WHERE id = 1;
  IF cfg IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'disabled');
  END IF;

  -- Detectar inactivos con teléfono, no contactados dentro del cooldown
  FOR r IN
    WITH cutoff AS (
      SELECT to_char(CURRENT_DATE - (cfg.meses_inactividad || ' months')::interval, 'YYYY-MM-DD') AS c
    ),
    canon AS (
      SELECT g.cod_cliente AS cod, v.cod_cliente AS canonico
      FROM customer_grupos g
      JOIN customer_grupos v ON v.grupo_id = g.grupo_id AND v.es_vigente
      WHERE g.empresa = 'lk'
    ),
    ult_erp AS (
      SELECT COALESCE(cn.canonico, sl.customer_code)::text AS cod,
             MAX(sl.invoice_date) AS last_txt
      FROM sales_lines sl
      LEFT JOIN canon cn ON cn.cod = sl.customer_code
      WHERE sl.empresa = 'lk' AND sl.customer_code IS NOT NULL
        AND sl.customer_code NOT IN ('1', '3878')
        AND sl.invoice_date IS NOT NULL
        AND sl.item_code <> ALL (ARRAY(SELECT item_code FROM sales_excluded_items))
      GROUP BY 1
    ),
    ult_web AS (
      SELECT COALESCE(cn.canonico, c.cod_cliente::text) AS cod,
             to_char(MAX(o.created_at::date), 'YYYY-MM-DD') AS last_txt
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN canon cn ON cn.cod = c.cod_cliente::text
      WHERE c.cod_cliente IS NOT NULL
        AND c.cod_cliente NOT IN ('1', '3878')
      GROUP BY 1
    ),
    ult AS (
      SELECT cod, MAX(last_txt) AS last_txt
      FROM (SELECT * FROM ult_erp UNION ALL SELECT * FROM ult_web) t
      GROUP BY cod
    ),
    inactivos AS (
      SELECT u.cod, u.last_txt
      FROM ult u CROSS JOIN cutoff
      WHERE u.last_txt < cutoff.c
        AND u.cod NOT IN (SELECT cod_cliente FROM lk_ch_excluidos_cache)
        AND u.cod NOT IN (SELECT cod_cliente FROM ranking_inactivos_excluidos)
    )
    SELECT
      i.cod AS cod_cliente,
      t.telefono,
      COALESCE(NULLIF(btrim(c.business_name), ''), 'cliente') AS business_name,
      i.last_txt
    FROM inactivos i
    JOIN wa_clientes_telefono t ON t.cod_cliente = i.cod
    LEFT JOIN customers c ON c.cod_cliente::text = i.cod
    WHERE NOT EXISTS (
      SELECT 1 FROM bot_reactivacion_log rl
      WHERE rl.cod_cliente = i.cod
        AND rl.contacted_at > CURRENT_DATE - (cfg.cooldown_dias || ' days')::interval
    )
    ORDER BY i.last_txt ASC  -- más antiguos primero
    LIMIT cfg.max_por_dia
  LOOP
    -- Normalizar teléfono (solo dígitos, formato internacional argentino)
    v_phone_clean := regexp_replace(r.telefono, '[^0-9]', '', 'g');
    IF v_phone_clean NOT LIKE '549%' AND v_phone_clean LIKE '54%' THEN
      v_phone_clean := '549' || substring(v_phone_clean from 3);
    ELSIF length(v_phone_clean) <= 11 AND v_phone_clean NOT LIKE '54%' THEN
      IF v_phone_clean LIKE '9%' THEN
        v_phone_clean := '54' || v_phone_clean;
      ELSE
        v_phone_clean := '549' || v_phone_clean;
      END IF;
    END IF;

    -- Construir mensaje desde template
    v_body := replace(cfg.mensaje_template, '{nombre}', r.business_name);

    -- Encolar en outbox (template Meta si configurado, sino texto libre)
    IF cfg.template_name IS NOT NULL THEN
      INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
      VALUES (v_phone_clean, cfg.template_name,
              jsonb_build_object('1', r.business_name),
              'reactivacion', r.cod_cliente)
      RETURNING id INTO v_outbox_id;
    ELSE
      INSERT INTO wa_outbox (phone, body, context, ref_id)
      VALUES (v_phone_clean, v_body, 'reactivacion', r.cod_cliente)
      RETURNING id INTO v_outbox_id;
    END IF;

    -- Registrar en log
    INSERT INTO bot_reactivacion_log (cod_cliente, telefono, business_name, outbox_id)
    VALUES (r.cod_cliente, v_phone_clean, r.business_name, v_outbox_id);

    n_enqueued := n_enqueued + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'enqueued', n_enqueued, 'at', now());
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Cron: lunes a viernes a las 9:00 AM Argentina (12:00 UTC)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT cron.schedule('bot_reactivar_inactivos', '0 12 * * 1-5',
--   $$SELECT bot_reactivar_inactivos()$$);
