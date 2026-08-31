-- 041_wa_agente_model_keys.sql
-- Almacén BLOQUEADO de API keys de modelos. La key se tipea en el front, viaja
-- al edge function (server), se valida contra el proveedor y se guarda acá.
-- RLS ON + sin policies → solo service_role (edge function) accede. El navegador
-- NUNCA la puede leer. Idempotente.

CREATE TABLE IF NOT EXISTS public.wa_agente_model_keys (
  id          bigserial PRIMARY KEY,
  api_key     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_agente_model_keys ENABLE ROW LEVEL SECURITY;
-- Sin policies: anon/authenticated quedan denegados. Revocamos grants por las dudas.
REVOKE ALL ON public.wa_agente_model_keys FROM anon, authenticated;

-- Extender la tabla de modelos: origen de la key (env var o tabla bloqueada).
ALTER TABLE public.wa_agente_modelos
  ADD COLUMN IF NOT EXISTS key_source text NOT NULL DEFAULT 'env',   -- 'env' | 'db'
  ADD COLUMN IF NOT EXISTS key_id bigint REFERENCES public.wa_agente_model_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS key_last4 text;

-- secret_ref ahora es opcional (los modelos con key en la tabla bloqueada no lo usan).
ALTER TABLE public.wa_agente_modelos ALTER COLUMN secret_ref DROP NOT NULL;
