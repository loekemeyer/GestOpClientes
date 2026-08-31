-- 038_wa_agente.sql
-- Perfil del agente IA de Gestión Operativa de Clientes:
--   - wa_agente_config: documento rector (.md) editable, copia viva que lee el bot
--   - wa_agente_consultas: cola de dudas del agente que un humano responde y categoriza
-- Idempotente.

-- ── Configuración / documento rector del agente ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_agente_config (
  id          smallint PRIMARY KEY DEFAULT 1,
  contenido   text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  CONSTRAINT wa_agente_config_singleton CHECK (id = 1)
);

-- Semilla inicial (solo si la fila no existe). El contenido real se sincroniza
-- con docs/AGENTE.md; acá va un placeholder mínimo para que el bot nunca quede
-- sin system prompt.
INSERT INTO public.wa_agente_config (id, contenido, updated_by)
VALUES (
  1,
  E'# Agente de Gestión Operativa de Clientes\n\n'
  '## Objetivo\n'
  'Responder las consultas de clientes mayoristas que no tienen plantilla '
  'automática (categoría INTELIGENCIA). Dar una respuesta útil, breve y '
  'correcta en tono de la marca, o derivar a un humano cuando corresponda.\n\n'
  '## Limitaciones y Permisos\n'
  '### Permisos (puede hacer)\n'
  '- Responder preguntas generales sobre la empresa, productos y modalidad mayorista.\n'
  '- Interpretar pedidos en lenguaje libre y proponer el match de producto.\n'
  '- Pedir aclaraciones cuando la consulta es ambigua.\n'
  '- Derivar a un vendedor cuando el caso lo excede.\n\n'
  '### Limitaciones (no puede hacer)\n'
  '- No inventa pedidos, precios, stock ni fechas.\n'
  '- No confirma pedidos, cambios ni cancelaciones por sí mismo.\n'
  '- No comparte datos de un cliente con otro.\n'
  '- No negocia precios ni condiciones fuera de sistema.\n\n'
  '## Consultas\n'
  'Cola de dudas del agente sobre objetivo, límites o permisos, que un humano '
  'responde y categoriza.',
  'seed'
)
ON CONFLICT (id) DO NOTHING;

-- ── Cola de consultas del agente ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_agente_consultas (
  id           bigserial PRIMARY KEY,
  pregunta     text NOT NULL,
  contexto     text,
  origen       text,                       -- teléfono / conversación / 'agente'
  categoria    text CHECK (categoria IN ('objetivo','limite','permiso')),
  respuesta    text,
  estado       text NOT NULL DEFAULT 'pendiente'
                 CHECK (estado IN ('pendiente','respondida','descartada')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  answered_by  text
);

CREATE INDEX IF NOT EXISTS wa_agente_consultas_estado_idx
  ON public.wa_agente_consultas (estado, created_at DESC);
