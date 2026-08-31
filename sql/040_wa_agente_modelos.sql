-- 040_wa_agente_modelos.sql
-- Submódulo "Modelos" de Configuración del agente.
-- Guarda SOLO la config del modelo (proveedor, model_id, cuál usa el agente).
-- Las API keys NO viven acá: se cargan en Supabase → Edge Functions → Secrets
-- (env vars), referenciadas por `secret_ref`. Así la key nunca toca la base ni
-- el navegador. Idempotente.

CREATE TABLE IF NOT EXISTS public.wa_agente_modelos (
  id          bigserial PRIMARY KEY,
  proveedor   text NOT NULL,              -- 'anthropic' | 'openai' | 'google' | 'otro'
  label       text NOT NULL,              -- nombre visible
  model_id    text NOT NULL,              -- ej: claude-sonnet-4-6
  secret_ref  text NOT NULL,              -- nombre de la env var en Supabase Secrets (ej: ANTHROPIC_API_KEY)
  activo      boolean NOT NULL DEFAULT true,
  es_default  boolean NOT NULL DEFAULT false,  -- el que usa el agente
  notas       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Un solo modelo default a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS wa_agente_modelos_default_uq
  ON public.wa_agente_modelos (es_default) WHERE es_default;

-- Seed: Anthropic ya conectado (key en Supabase Secrets como ANTHROPIC_API_KEY).
INSERT INTO public.wa_agente_modelos (proveedor, label, model_id, secret_ref, es_default, notas)
SELECT * FROM (VALUES
  ('anthropic', 'Anthropic Claude Sonnet', 'claude-sonnet-4-6', 'ANTHROPIC_API_KEY', true,  'Conversacional / respuestas del agente'),
  ('anthropic', 'Anthropic Claude Haiku',  'claude-haiku-4-5',  'ANTHROPIC_API_KEY', false, 'Clasificación / parsing (barato)')
) AS v(proveedor, label, model_id, secret_ref, es_default, notas)
WHERE NOT EXISTS (SELECT 1 FROM public.wa_agente_modelos);
