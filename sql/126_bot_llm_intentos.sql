-- 126_bot_llm_intentos.sql — Auditoría de cada intento a un modelo de IA (Pablo Olejavetzky, 05/10/2026)
--
-- `bot_token_usage` sólo guarda las llamadas que salieron bien: no hay forma de saber cuántas veces falló un modelo,
-- con qué código (429, 503, timeout) ni cuánto tardó. `_shared/bot-llm.ts` (`logIntento`) escribe acá una fila por intento
-- desde `runConversation`. Sin teléfono ni texto del cliente: sólo datos técnicos.
--
--   modelo_id : wa_agente_modelos.id · 0 = fallback de env (Sonnet) · -1 = modelo de pruebas (llm_modelo_pruebas)
--   http_status: null cuando fue timeout (30 s) o error de red
--   error     : sin la API key (limpiarErrorLlm), máx. 800 caracteres (hasta el 05/10 eran 300: el detalle de cuota del 429 quedaba afuera)
--
-- RLS prendida y sin políticas: sólo la lee `service_role` (regla de CLAUDE.md: toda tabla nueva nace con RLS).
-- Idempotente.

create table if not exists public.bot_llm_intentos (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  funcion text, modelo_id integer, proveedor text, modelo text, tarea text,
  iteracion smallint, ok boolean not null,
  http_status integer, error text, duracion_ms integer,
  input_tokens integer, output_tokens integer
);
alter table public.bot_llm_intentos enable row level security;
create index if not exists bot_llm_intentos_fecha_idx on public.bot_llm_intentos (created_at desc);
create index if not exists bot_llm_intentos_modelo_idx on public.bot_llm_intentos (modelo, created_at desc);
