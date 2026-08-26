-- ============================================================
-- 012_wa_rate_limit_blacklist.sql
-- Rate limiting por teléfono + blacklist de números
-- ============================================================

-- Rate limit: contador de mensajes por teléfono por ventana horaria
CREATE TABLE IF NOT EXISTS wa_rate_limit (
  phone        text        NOT NULL,
  window_start timestamptz NOT NULL,
  msg_count    int         NOT NULL DEFAULT 1,
  PRIMARY KEY (phone, window_start)
);

-- Blacklist de teléfonos
CREATE TABLE IF NOT EXISTS wa_blacklist (
  id         serial      PRIMARY KEY,
  phone      text        UNIQUE NOT NULL,
  reason     text,
  created_at timestamptz DEFAULT now(),
  created_by text
);

-- Settings por defecto
INSERT INTO app_settings (key, value)
VALUES ('wa_rate_limit_per_hour', 20)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value)
VALUES ('wa_rate_limit_enabled', 1)
ON CONFLICT (key) DO NOTHING;

-- Función: chequea rate limit y devuelve true si está bloqueado
CREATE OR REPLACE FUNCTION wa_check_rate_limit(p_phone text, p_limit int)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_window timestamptz;
  v_count  int;
BEGIN
  v_window := date_trunc('hour', now());

  INSERT INTO wa_rate_limit (phone, window_start, msg_count)
  VALUES (p_phone, v_window, 1)
  ON CONFLICT (phone, window_start)
  DO UPDATE SET msg_count = wa_rate_limit.msg_count + 1
  RETURNING msg_count INTO v_count;

  -- Limpieza de ventanas viejas (>24h)
  DELETE FROM wa_rate_limit WHERE window_start < now() - interval '24 hours';

  RETURN v_count > p_limit;
END;
$$;
