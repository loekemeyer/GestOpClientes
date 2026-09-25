-- Sandbox local — CAPA DE TRACE (base del proyecto de observabilidad).
-- Un registro estructurado por mensaje: qué compuerta, qué tools, qué modelo, tokens,
-- latencia, decisión. Es el equivalente a la "vista de ejecución" de n8n.
--
-- Versión sandbox (sin RLS/auth de Supabase para que corra en Postgres pelado).
-- Para prod: migración numerada aparte (sql/NNN) con RLS ON + solo service_role.

create table if not exists bot_trace (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  phone       text,
  source      text,          -- lk_whatsapp-webhook | lk_chat-test
  message_in  text,          -- lo que escribió el cliente
  gate        text,          -- compuerta final: killswitch | faq_full_auto | faq_semi_auto | agente | registro | blacklist
  faq_id      bigint,        -- si matcheó FAQ
  faq_score   numeric,
  model       text,          -- modelo que respondió (si fue al agente)
  iterations  int,           -- vueltas del loop de tools
  tool_calls  jsonb,         -- [{name, input, ok, ms}]
  tokens_in   int,
  tokens_out  int,
  cost_usd    numeric,
  latency_ms  int,
  reply       text,
  outcome     text,          -- ok | timeout | llm_error | escalated | silenced
  error       text
);
create index if not exists idx_bot_trace_ts    on bot_trace(created_at desc);
create index if not exists idx_bot_trace_phone on bot_trace(phone, created_at desc);
create index if not exists idx_bot_trace_gate  on bot_trace(gate);

-- Un único punto de escritura: el código TS arma un jsonb y llama bot_trace_log(p) una vez
-- por mensaje. Así instrumentar runConversation es una sola línea al final del turno.
create or replace function bot_trace_log(p jsonb)
returns bigint language sql as $$
  insert into bot_trace (phone, source, message_in, gate, faq_id, faq_score, model, iterations,
                         tool_calls, tokens_in, tokens_out, cost_usd, latency_ms, reply, outcome, error)
  values (
    p->>'phone', p->>'source', p->>'message_in', p->>'gate',
    nullif(p->>'faq_id','')::bigint, nullif(p->>'faq_score','')::numeric,
    p->>'model', nullif(p->>'iterations','')::int,
    coalesce(p->'tool_calls','[]'::jsonb),
    nullif(p->>'tokens_in','')::int, nullif(p->>'tokens_out','')::int,
    nullif(p->>'cost_usd','')::numeric, nullif(p->>'latency_ms','')::int,
    p->>'reply', p->>'outcome', p->>'error'
  )
  returning id;
$$;
