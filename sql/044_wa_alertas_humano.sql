-- 044_wa_alertas_humano.sql
-- Cola de alertas que necesitan atención humana. Por ahora solo la usa el
-- pipeline de timeout del bot: cuando el LLM no responde en el plazo
-- esperado, insertamos una fila acá para que un humano pueda hacer
-- seguimiento. El "sistema de aviso" real (notificación al vendedor por
-- WhatsApp, email, dashboard, etc.) se conecta después leyendo esta tabla.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS public.wa_alertas_humano (
  id            bigserial PRIMARY KEY,
  tipo          text NOT NULL,                     -- 'llm_timeout' | ...
  phone         text,                              -- teléfono del cliente afectado
  customer_id   uuid,                              -- si estaba identificado
  contexto      jsonb NOT NULL DEFAULT '{}'::jsonb,-- payload libre (mensaje del cliente, modelo que falló, error)
  estado        text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','notificado','atendido','descartado')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  atendido_por  text,
  atendido_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_wa_alertas_humano_pendientes
  ON public.wa_alertas_humano (created_at DESC)
  WHERE estado = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_wa_alertas_humano_tipo
  ON public.wa_alertas_humano (tipo, created_at DESC);

COMMENT ON TABLE public.wa_alertas_humano IS
  'Cola de eventos que requieren revisión humana. Alimentada por el bot (timeouts, errores irrecuperables) y consumida por el sistema de notificación (futuro).';
