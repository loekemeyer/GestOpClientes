-- 057 — Idempotencia del webhook por `wamid` (punto 9 de la auditoría del 2026-09-07)
--
-- EL PROBLEMA
-- ===========
-- Meta **reintenta** un webhook cuando no recibe el 200 a tiempo (o cuando cree que no lo
-- recibió). Hoy el camino de TEXTO no tiene ninguna protección: el mismo mensaje entra dos
-- veces, el bot lo contesta dos veces y —lo caro— si el mensaje era una confirmación de pedido,
-- `enviar_pedido` corre dos veces y **el pedido se duplica**.
--
-- El repo ya sabía del problema en otros caminos y lo había resuelto ahí:
--   · `wa_message_status` tiene `unique(wamid, status)`  (sql/050:24, con el comentario
--     "Meta reintenta webhooks")
--   · `wa_comprobantes.wamid` es unique
-- El texto era el único sin candado.
--
-- LA SOLUCIÓN
-- ===========
-- Una tabla chica con el `wamid` como clave primaria. El webhook, ANTES de hacer nada, intenta
-- insertar la fila: si entra, es la primera vez y sigue; si choca, es un reintento y se
-- devuelve 200 sin procesar. El `insert ... on conflict do nothing` es atómico, así que dos
-- entregas simultáneas del mismo mensaje no se pisan (que es justo lo que pasa en un reintento
-- rápido de Meta).
--
-- No guarda contenido: sólo el id de Meta, el teléfono y cuándo se vio. No es un log —para eso
-- está `wa_conversations`—, es un candado.
--
-- RLS prendida y SIN policies: sólo `service_role` (que la saltea) puede tocarla. La anon key
-- de PaginaLK es pública (viaja en `docs/index.html`), así que nadie de afuera tiene por qué
-- leer ni escribir acá; y menos poder marcar un mensaje como "ya visto" para que el bot lo
-- ignore, que sería una forma barata de silenciar al bot.
--
-- La tabla se limpia sola: el índice por fecha permite borrar lo viejo. Meta no reintenta más
-- allá de unas horas, así que con 7 días sobra y de paso queda margen para debuggear.

create table if not exists public.wa_inbound_seen (
  wamid      text primary key,
  phone      text,
  first_seen timestamptz not null default now()
);

create index if not exists wa_inbound_seen_first_seen_idx
  on public.wa_inbound_seen (first_seen);

alter table public.wa_inbound_seen enable row level security;
-- Sin policies a propósito: sólo service_role.

comment on table public.wa_inbound_seen is
  'Candado de idempotencia del webhook de WhatsApp. Una fila por wamid ya procesado. '
  'Meta reintenta los webhooks; sin esto el mismo mensaje se contesta dos veces y un pedido '
  'confirmado se duplica. Lo escribe lk_whatsapp-webhook con service_role antes de procesar.';

-- Limpieza de lo viejo (llamable desde pg_cron; sin cron por ahora, la tabla es minúscula).
create or replace function public.wa_inbound_seen_limpiar(p_dias integer default 7)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  with borradas as (
    delete from public.wa_inbound_seen
     where first_seen < now() - (p_dias || ' days')::interval
    returning 1
  )
  select count(*)::integer from borradas;
$$;

revoke all on function public.wa_inbound_seen_limpiar(integer) from public, anon, authenticated;

-- ROLLBACK
--   drop function if exists public.wa_inbound_seen_limpiar(integer);
--   drop table if exists public.wa_inbound_seen;
