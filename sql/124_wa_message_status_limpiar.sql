-- 124 — Poda diaria de wa_message_status (auditoría del 02/10/2026, sección 3.4; retención de 30 días, Pablo 02/10)
--
-- `wa_message_status` guarda los delivery reports de Meta (sent/delivered/read/failed): 3-4 filas por mensaje saliente,
-- más los de Business Suite. Es la tabla del bot que más crece: 6.524 filas / 5,1 MB el 02/10 (primera fila 02/09), sin poda.
--
-- Quién la lee y hasta dónde mira (02/10):
--   · _shared/salientes.ts (Dashboard › IA/envíos): hasta 30 días, con un día de margen → 31.
--   · lk_fallas-mail (mail de fallas): `failed` de hasta 30 días.
--   · lk_whatsapp-webhook: sólo escribe (upsert por wamid+status).
-- Por eso la poda corta en 31 días y no en 30: así la vista "30 días" del dashboard queda completa. Ninguna vista ni FK
-- depende de la tabla (information_schema.view_table_usage y pg_constraint, 02/10).
--
-- Misma forma que wa_inbound_seen_limpiar (sql/057). 04:20 UTC = 01:20 AR, cinco minutos después de la poda de
-- wa_inbound_seen (sql/123). `cron.schedule(nombre, …)` hace upsert por nombre: idempotente.
--
-- ESTADO (02/10/2026): la función está creada en producción (anon sin EXECUTE, verificado). El `cron.schedule` de abajo
-- se agenda con el "sí" de Pablo (regla BD del CLAUDE.md: toda escritura con su efecto a la vista). Hoy borraría 0 filas.

create or replace function public.wa_message_status_limpiar(p_dias integer default 31)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  with borradas as (
    delete from public.wa_message_status
     where received_at < now() - (p_dias || ' days')::interval
    returning 1
  )
  select count(*)::integer from borradas;
$$;

revoke all on function public.wa_message_status_limpiar(integer) from public, anon, authenticated;

comment on function public.wa_message_status_limpiar(integer) is
  'Borra los delivery reports de Meta (wa_message_status) con más de p_dias días (default 31: 30 días de dashboard + 1 de margen). '
  'La agenda el cron wa_message_status_limpiar (sql/124).';

select cron.schedule('wa_message_status_limpiar', '20 4 * * *', $$select public.wa_message_status_limpiar(31)$$);

-- ROLLBACK
--   select cron.unschedule('wa_message_status_limpiar');
--   drop function if exists public.wa_message_status_limpiar(integer);
