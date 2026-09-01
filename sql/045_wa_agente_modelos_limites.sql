-- 045_wa_agente_modelos_limites.sql
-- Cuotas por modelo (para mantenerse dentro de tiers gratuitos) y flag
-- de gratuidad para el medidor de costos. Idempotente.
--
-- Semántica de las columnas:
--   is_free_tier         → true = el modelo se cobra a $0 en el medidor
--                          (aunque haya rates en el código, se ignoran).
--   daily_request_limit  → NULL = sin límite; N = si superás N requests
--                          en el día UTC, el modelo se salta en la chain
--                          hasta que dé la vuelta al día.
--   daily_token_limit    → NULL = sin límite; N = ídem pero por
--                          input+output tokens del día.
--   rpm_limit            → NULL = sin límite; N = requests por minuto.
--                          Se calcula con ventana móvil de 60s.
--
-- El chequeo se hace en el edge function (llm.ts) contra `bot_token_usage`
-- justo antes de disparar la request. Si se excede, se marca el modelo
-- como "caido" con `cooldown_hasta` = fin del período (fin del día para
-- diarios; +60s para rpm) y se pasa al siguiente en la cadena.

ALTER TABLE public.wa_agente_modelos
  ADD COLUMN IF NOT EXISTS is_free_tier        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_request_limit int,
  ADD COLUMN IF NOT EXISTS daily_token_limit   int,
  ADD COLUMN IF NOT EXISTS rpm_limit           int;

-- Precarga de límites conocidos del free tier de Google AI Studio para
-- los Gemini más usados. Si ya alguien los tocó, no los pisamos.
UPDATE public.wa_agente_modelos
   SET is_free_tier = true,
       rpm_limit = COALESCE(rpm_limit, 30),
       daily_request_limit = COALESCE(daily_request_limit, 1500)
 WHERE proveedor = 'google'
   AND model_id ILIKE '%flash-lite%'
   AND is_free_tier = false;

UPDATE public.wa_agente_modelos
   SET is_free_tier = true,
       rpm_limit = COALESCE(rpm_limit, 15),
       daily_request_limit = COALESCE(daily_request_limit, 1500)
 WHERE proveedor = 'google'
   AND model_id ILIKE '%2.5-flash%'
   AND model_id NOT ILIKE '%flash-lite%'
   AND is_free_tier = false;

COMMENT ON COLUMN public.wa_agente_modelos.is_free_tier IS
  'Si true, el medidor de costos lo contabiliza a $0 y muestra badge "gratis".';
COMMENT ON COLUMN public.wa_agente_modelos.daily_request_limit IS
  'Requests máximos por día (UTC). NULL = sin límite. El bot lo salta al alcanzarlo.';
COMMENT ON COLUMN public.wa_agente_modelos.daily_token_limit IS
  'Tokens (input+output) máximos por día. NULL = sin límite.';
COMMENT ON COLUMN public.wa_agente_modelos.rpm_limit IS
  'Requests por minuto en ventana móvil de 60s. NULL = sin límite.';
