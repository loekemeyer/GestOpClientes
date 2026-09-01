-- 042_wa_agente_model_chain.sql
-- Amplía Modelos a: una key = varios modelos disponibles + cadena jerárquica
-- (prioridad) + estado de salud para failover. Idempotente.
--
-- wa_agente_model_keys  = credencial (proveedor + key). Una key.
-- wa_agente_modelos     = modelos DISPONIBLES (una fila por modelo de cada key).
--                         prioridad NULL = no está en la cadena. 1 = primero.

-- ── Keys como registro de credenciales ───────────────────────────────────────
ALTER TABLE public.wa_agente_model_keys
  ADD COLUMN IF NOT EXISTS proveedor  text,
  ADD COLUMN IF NOT EXISTS label      text,
  ADD COLUMN IF NOT EXISTS key_source text NOT NULL DEFAULT 'db',   -- 'db' | 'env'
  ADD COLUMN IF NOT EXISTS secret_ref text,
  ADD COLUMN IF NOT EXISTS key_last4  text;
ALTER TABLE public.wa_agente_model_keys ALTER COLUMN api_key DROP NOT NULL;

-- ── Modelos: cadena de prioridad + salud ─────────────────────────────────────
ALTER TABLE public.wa_agente_modelos
  ADD COLUMN IF NOT EXISTS prioridad      int,               -- NULL = no en uso; 1 = primero
  ADD COLUMN IF NOT EXISTS estado         text NOT NULL DEFAULT 'ok',  -- 'ok' | 'caido'
  ADD COLUMN IF NOT EXISTS cooldown_hasta timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_error   text;

-- ── Migración de datos: la Anthropic de Secrets pasa a ser una "key" env ─────
DO $$
DECLARE kid bigint;
BEGIN
  SELECT id INTO kid FROM public.wa_agente_model_keys
   WHERE key_source = 'env' AND secret_ref = 'ANTHROPIC_API_KEY' LIMIT 1;
  IF kid IS NULL THEN
    INSERT INTO public.wa_agente_model_keys (proveedor, label, key_source, secret_ref, api_key)
    VALUES ('anthropic', 'Anthropic (Secrets)', 'env', 'ANTHROPIC_API_KEY', NULL)
    RETURNING id INTO kid;
  END IF;
  UPDATE public.wa_agente_modelos
     SET key_id = kid
   WHERE proveedor = 'anthropic' AND key_id IS NULL;
END $$;

-- Sonnet arranca #1 en la cadena; Haiku queda disponible (fuera de cadena).
UPDATE public.wa_agente_modelos SET prioridad = 1
 WHERE model_id = 'claude-sonnet-4-6' AND prioridad IS NULL;
UPDATE public.wa_agente_modelos SET prioridad = NULL
 WHERE model_id = 'claude-haiku-4-5';
