-- 136 — Tiempo de punta a punta de cada respuesta del bot (Pablo Olejavetzky, 09/10/2026).
-- Para medir el objetivo de 3 a 6 s (docs/REQUERIMIENTOS-AGENTE-2026-10-09.md). Lo escribe lk_whatsapp-webhook
-- (_shared/tiempos-turno.ts) una fila por mensaje entrante que ganó el candado de idempotencia, después de contestar.
-- Hasta acá no había cómo: wa_conversations graba pregunta y respuesta juntas (0,0 s) y bot_llm_intentos sólo mide el modelo.
--
-- Columnas de tiempo (todas con el reloj de la edge, salvo meta_at):
--   meta_at          cuando el cliente lo mandó, según Meta (precisión de 1 s)
--   recibido_at      cuando el POST entró al webhook
--   primer_envio_at  cuando Meta aceptó la primera respuesta  ← lo que ve el cliente
--   ultimo_envio_at  cuando Meta aceptó la última (fotos, catálogo, texto)
--   fin_at           cuando terminó de procesar (después pueden quedar escrituras de historial)
--   envio_ms         suma del tiempo dentro de los POST a Meta (incluye la consulta de wa-guard)
--   ia_ms            tiempo dentro de runConversation (0 si contestó una respuesta fija)
-- envios = 0 → el cliente no recibió nada (descartado por whitelist, IA caída, modo humano…).
-- concurrente → había otro mensaje del mismo número procesándose: dejarlo afuera de la medición.

create table if not exists public.wa_turno_tiempos (
  wamid           text primary key,
  phone           text not null,
  tipo            text not null default 'text',
  meta_at         timestamptz,
  recibido_at     timestamptz not null,
  primer_envio_at timestamptz,
  ultimo_envio_at timestamptz,
  fin_at          timestamptz not null,
  envios          smallint not null default 0,
  envio_ms        integer not null default 0,
  ia              boolean not null default false,
  ia_ms           integer not null default 0,
  concurrente     boolean not null default false,
  error           text,
  creado_en       timestamptz not null default now()
);
alter table public.wa_turno_tiempos enable row level security;  -- sin políticas: sólo service_role
revoke all on table public.wa_turno_tiempos from anon, authenticated;
create index if not exists wa_turno_tiempos_recibido_idx on public.wa_turno_tiempos (recibido_at desc);

-- Segundos listos para leer. respuesta_s = lo que espera el cliente desde que el mensaje llegó al webhook;
-- total_s suma lo que tardó Meta en entregarnos el mensaje (con la precisión de 1 s de meta_at).
create or replace view public.v_wa_turno_tiempos with (security_invoker = true) as
select wamid, phone, tipo, ia, envios, concurrente, error, recibido_at,
       round(extract(epoch from (recibido_at - meta_at))::numeric, 1)          as llegada_s,
       round(extract(epoch from (primer_envio_at - recibido_at))::numeric, 2)  as respuesta_s,
       round(extract(epoch from (primer_envio_at - meta_at))::numeric, 1)      as total_s,
       round(ia_ms / 1000.0, 2)                                                as ia_s,
       round(envio_ms / 1000.0, 2)                                             as envio_s,
       round(extract(epoch from (fin_at - recibido_at))::numeric, 2)           as proceso_s
  from public.wa_turno_tiempos;
revoke all on table public.v_wa_turno_tiempos from anon, authenticated;

-- Rollback:
--   drop view if exists public.v_wa_turno_tiempos;
--   drop table if exists public.wa_turno_tiempos;
