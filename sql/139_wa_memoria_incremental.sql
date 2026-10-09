-- 139 — Memoria por cliente, parte incremental (Pablo Olejavetzky, 09/10/2026: "cuando un cliente lo agarre el agente, que lo agregue a la memoria").
-- Cada charla del bot que se cierra (12 h sin mensajes en bot_historial_chat) se suma a la ficha del cliente (lk_memoria-cliente
-- {action:"incremental"}, cron lk_memoria-incremental cada hora).
--
-- wa_memoria_telefono: hasta dónde se sumó cada teléfono (bot_hasta = creado_en del último mensaje leído).
-- ⚠ ARRANCA DESDE HOY: los 34 teléfonos que ya tienen historial con el bot son de prueba o de la whitelist, y varios están asociados a
-- clientes reales (el canal de prueba, al 4028 Bazar Farimar, TEMPORAL). Sumar esas charlas metería pruebas en fichas reales. Por eso se
-- marcan como vistos hasta su último mensaje de hoy, y el canal de prueba (la fila MÁS VIEJA de wa_envio_contactos, la misma regla de
-- lk_bot-simular) se deja afuera siempre.
-- Una charla con menos de 2 mensajes del cliente no se suma (un "gracias" no gasta).

create table if not exists public.wa_memoria_telefono (
  telefono        text primary key,
  bot_hasta       timestamptz not null,
  actualizado_en  timestamptz not null default now(),
  resultado       text   -- creada | sumada | no_cliente_lk | sin_mensajes | inicial
);
alter table public.wa_memoria_telefono enable row level security;  -- sin políticas: sólo service_role
revoke all on table public.wa_memoria_telefono from anon, authenticated;

insert into public.wa_memoria_telefono (telefono, bot_hasta, resultado)
select telefono, max(creado_en), 'inicial' from public.bot_historial_chat group by telefono
on conflict (telefono) do nothing;

create or replace function public.wa_memoria_incremental_pendientes(p_limite integer default 5)
returns table (telefono text, desde timestamptz, hasta timestamptz, nuevos_cliente integer)
language sql stable security definer set search_path = public as $$
  with prueba as (
    select right(regexp_replace(phone, '\D', '', 'g'), 10) tel10 from public.wa_envio_contactos order by created_at, id limit 1
  ), t as (
    select h.telefono, v.bot_hasta as desde, max(h.creado_en) as hasta,
           count(*) filter (where h.rol = 'user') as nuevos_cliente
      from public.bot_historial_chat h
      left join public.wa_memoria_telefono v on v.telefono = h.telefono
     where h.creado_en > coalesce(v.bot_hasta, '-infinity'::timestamptz)
     group by h.telefono, v.bot_hasta
  )
  select t.telefono, t.desde, t.hasta, t.nuevos_cliente::integer
    from t
   where t.hasta < now() - interval '12 hours'
     and t.nuevos_cliente >= 2
     and right(regexp_replace(t.telefono, '\D', '', 'g'), 10) is distinct from (select tel10 from prueba)
   order by t.hasta
   limit greatest(1, least(p_limite, 20));
$$;
revoke all on function public.wa_memoria_incremental_pendientes(integer) from public, anon, authenticated;
grant execute on function public.wa_memoria_incremental_pendientes(integer) to service_role;

-- Rollback:
--   drop function if exists public.wa_memoria_incremental_pendientes(integer);
--   drop table if exists public.wa_memoria_telefono;
