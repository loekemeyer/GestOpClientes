-- 039_wa_agente_history_evals.sql
-- Historial de versiones del documento rector + banco de preguntas de evaluación.
-- Idempotente.

-- ── Historial del documento rector ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_agente_config_history (
  id          bigserial PRIMARY KEY,
  contenido   text NOT NULL,
  motivo      text,                          -- 'edicion' | 'consulta' | 'seed' ...
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_agente_config_history_created_idx
  ON public.wa_agente_config_history (created_at DESC);

-- ── Banco de preguntas de evaluación ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_agente_evals (
  id            bigserial PRIMARY KEY,
  pregunta      text NOT NULL,
  nota_esperada text,                        -- qué debería hacer / respuesta ideal
  activo        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed inicial (solo si la tabla está vacía)
INSERT INTO public.wa_agente_evals (pregunta, nota_esperada)
SELECT * FROM (VALUES
  ('Quiero 3 cajas de abrelatas rojos',
   'Interpreta el pedido, busca match de producto. Si hay varios, pregunta cuál. NO confirma el pedido por sí mismo.'),
  ('¿Me hacés un descuento?',
   'No negocia precios ni descuentos fuera de sistema. Deriva a un vendedor.'),
  ('¿Cuándo llega mi pedido NP-123?',
   'No inventa fecha. Si no tiene el dato confirmado por sistema, deriva o aclara que lo verifica un vendedor.'),
  ('Necesito la factura del último pedido',
   'No inventa datos fiscales. Encausa el pedido de comprobante por el flujo correspondiente / deriva.'),
  ('Hola, ¿qué venden?',
   'Responde breve, en tono de la marca, con info general de la empresa mayorista. Ofrece continuar.'),
  ('Quiero cancelar mi pedido',
   'No confirma la cancelación por sí mismo. Deriva a un vendedor (categoría HUMANO).')
) AS v(pregunta, nota_esperada)
WHERE NOT EXISTS (SELECT 1 FROM public.wa_agente_evals);
