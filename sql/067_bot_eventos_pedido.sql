-- 067 — Eventos de pedido para avisos PROACTIVOS por WhatsApp (plantillas de Meta).
--
-- Pedido de Luis (24/09/2026): poder programar avisos tipo "Tu pedido está programado para el
-- xx/xx/xx" o "Estamos armando tu pedido". Fuera de la ventana de 24 h Meta sólo deja mandar
-- PLANTILLAS aprobadas, así que el dato tiene que quedar listo para rellenarlas.
--
-- Tres piezas:
--   1. bot_pedido_estado_foto  — último estado conocido de cada pedido (LK).
--   2. bot_pedido_eventos      — un renglón por CAMBIO detectado (la cola que se programa).
--   3. bot_evento_config       — por tipo de evento: plantilla de Meta y si está activo.
--      Arranca TODO APAGADO: nada sale hasta que se cargue la plantilla y se prenda.
--
-- Fuente: virgilio.gv_pedido_web_estado_pagina (Gestión, por FDW) — la misma de sql/066.
-- NO usa bot_pending_notifications a propósito: esa cola la vacía la edge function externa
-- `notify-tracking-status` (cron 5, cada minuto) con texto libre, y cargarle eventos podría
-- mandar mensajes sin plantilla.
--
-- Etapas (de estado de Gestión):
--   sin_programar → recibido · programado → programado
--   en_picking / pickeado / en_armado / armado → armando · facturado · entregado
-- Tipos de evento:
--   programado    recibido → programado (trae fecha)
--   reprogramado  cambia la fecha estando programado o armando
--   armando       entra a picking/armado
--   facturado · entregado
--   desprogramado vuelve a recibido (se anota; no tiene plantilla por defecto)
--
-- ⚠ Primera corrida: `bot_detectar_eventos_pedido(p_sembrar => true)` llena la foto SIN
--   generar eventos. Si no, el primer barrido anota ~150 "cambios" de pedidos viejos.

create table if not exists public.bot_pedido_estado_foto (
  order_id      bigint primary key,
  etapa         text not null,
  estado_gv     text,
  fecha_entrega date,
  visto_at      timestamptz not null default now(),
  cambiado_at   timestamptz not null default now()
);
alter table public.bot_pedido_estado_foto enable row level security;

create table if not exists public.bot_pedido_eventos (
  id              bigserial primary key,
  order_id        bigint not null,
  customer_id     uuid,
  cod_cliente     bigint,
  tipo            text not null,
  etapa_anterior  text,
  etapa_nueva     text,
  fecha_anterior  date,
  fecha_nueva     date,
  detectado_at    timestamptz not null default now(),
  envio_estado    text not null default 'pendiente'
                  check (envio_estado in ('pendiente','no_enviar','enviado','error')),
  enviado_at      timestamptz,
  envio_detalle   jsonb
);
create index if not exists bot_pedido_eventos_pend_idx on public.bot_pedido_eventos (detectado_at) where envio_estado = 'pendiente';
create index if not exists bot_pedido_eventos_order_idx on public.bot_pedido_eventos (order_id);
alter table public.bot_pedido_eventos enable row level security;

create table if not exists public.bot_evento_config (
  tipo           text primary key,
  activo         boolean not null default false,
  plantilla      text,               -- nombre de la plantilla APROBADA en Meta
  idioma         text not null default 'es_AR',
  texto_ejemplo  text,               -- cómo se lee, para el panel (no es lo que se manda)
  vigencia_horas int not null default 48,  -- evento más viejo que esto no se manda (queda 'no_enviar')
  actualizado_at timestamptz not null default now()
);
alter table public.bot_evento_config enable row level security;

insert into public.bot_evento_config (tipo, texto_ejemplo) values
  ('programado',    'Hola {{1}}, tu pedido Nº {{2}} está programado para el {{3}}.'),
  ('reprogramado',  'Hola {{1}}, cambió la fecha de entrega de tu pedido Nº {{2}}: ahora es el {{3}}.'),
  ('armando',       'Hola {{1}}, estamos armando tu pedido Nº {{2}}. Sale el {{3}}.'),
  ('facturado',     'Hola {{1}}, tu pedido Nº {{2}} ya está facturado y sale el {{3}}.'),
  ('entregado',     'Hola {{1}}, tu pedido Nº {{2}} figura entregado el {{3}}.'),
  ('desprogramado', null)
on conflict (tipo) do nothing;

create or replace function public.bot_etapa_de_estado_gv(p text)
returns text language sql immutable as $$
  select case p
    when 'sin_programar' then 'recibido'
    when 'programado'    then 'programado'
    when 'en_picking'    then 'armando'
    when 'pickeado'      then 'armando'
    when 'en_armado'     then 'armando'
    when 'armado'        then 'armando'
    when 'facturado'     then 'facturado'
    when 'entregado'     then 'entregado'
    else null end
$$;

-- Detector. p_simular = true no escribe nada: devuelve lo que HARÍA.
create or replace function public.bot_detectar_eventos_pedido(p_simular boolean default true,
                                                              p_sembrar boolean default false)
returns table(order_id bigint, cod_cliente bigint, tipo text, etapa_anterior text, etapa_nueva text,
              fecha_anterior date, fecha_nueva date)
language plpgsql security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  drop table if exists _bev_actual; drop table if exists _bev_ev;
  create temp table _bev_actual on commit drop as
  with o as (
    select o.id, o.customer_id, c.cod_cliente
      from public.orders o
      left join public.customers c on c.id = o.customer_id
     where o.created_at >= now() - interval '90 days'
       and o.sheets_sent is not false
  ), g as (
    select g.order_id, g.estado, g.fecha_entrega, g.entregado_at
      from virgilio.gv_pedido_web_estado_pagina g
     where g.empresa = 'lk' and g.order_id = any(array(select id from o))
  )
  select o.id order_id, o.customer_id, o.cod_cliente, g.estado estado_gv,
         public.bot_etapa_de_estado_gv(g.estado) etapa,
         case when g.estado = 'entregado'
              then coalesce((g.entregado_at at time zone 'America/Argentina/Buenos_Aires')::date, g.fecha_entrega)
              when g.estado = 'sin_programar' then null
              else g.fecha_entrega end fecha_entrega
    from o join g on g.order_id = o.id;

  create temp table _bev_ev on commit drop as
  select a.order_id, a.customer_id, a.cod_cliente,
         case
           when f.order_id is null and a.etapa = 'recibido' then null      -- pedido nuevo sin programar: nada que avisar
           when f.order_id is null then a.etapa                             -- apareció ya avanzado
           when a.etapa = f.etapa then
             case when a.etapa in ('programado','armando') and a.fecha_entrega is distinct from f.fecha_entrega
                       and a.fecha_entrega is not null then 'reprogramado' end
           when a.etapa = 'recibido' then 'desprogramado'
           else a.etapa
         end tipo,
         f.etapa etapa_anterior, a.etapa etapa_nueva, f.fecha_entrega fecha_anterior, a.fecha_entrega fecha_nueva
    from _bev_actual a
    left join public.bot_pedido_estado_foto f on f.order_id = a.order_id
   where a.etapa is not null;

  if not p_simular then
    if not p_sembrar then
      insert into public.bot_pedido_eventos
        (order_id, customer_id, cod_cliente, tipo, etapa_anterior, etapa_nueva, fecha_anterior, fecha_nueva)
      select e.order_id, e.customer_id, e.cod_cliente, e.tipo, e.etapa_anterior, e.etapa_nueva, e.fecha_anterior, e.fecha_nueva
        from _bev_ev e where e.tipo is not null;
    end if;

    insert into public.bot_pedido_estado_foto as f (order_id, etapa, estado_gv, fecha_entrega, visto_at, cambiado_at)
    select a.order_id, a.etapa, a.estado_gv, a.fecha_entrega, now(), now()
      from _bev_actual a where a.etapa is not null
    on conflict (order_id) do update
       set visto_at = now(),
           cambiado_at = case when (f.etapa, f.fecha_entrega) is distinct from (excluded.etapa, excluded.fecha_entrega)
                              then now() else f.cambiado_at end,
           etapa = excluded.etapa, estado_gv = excluded.estado_gv, fecha_entrega = excluded.fecha_entrega
     where (f.etapa, f.estado_gv, f.fecha_entrega) is distinct from (excluded.etapa, excluded.estado_gv, excluded.fecha_entrega)
        or f.visto_at < now() - interval '1 hour';
  end if;

  return query
  select e.order_id, e.cod_cliente, e.tipo, e.etapa_anterior, e.etapa_nueva, e.fecha_anterior, e.fecha_nueva
    from _bev_ev e where e.tipo is not null or p_sembrar
   order by e.order_id;
end
$function$;

revoke execute on function public.bot_detectar_eventos_pedido(boolean, boolean) from public, anon, authenticated;
grant  execute on function public.bot_detectar_eventos_pedido(boolean, boolean) to service_role;

-- Lo que un ENVIADOR tiene que mandar: eventos pendientes de tipos ACTIVOS, dentro de la
-- vigencia, con la plantilla y las 3 variables ya armadas ({{1}} nombre, {{2}} Nº, {{3}} fecha).
-- Teléfono: customers.whatsapp (el mismo padrón que usa wa_identify_customer como respaldo).
-- Chequear el teléfono y la lista blanca (wa_envio_whitelist) es trabajo del enviador.
create or replace view public.bot_eventos_para_enviar
with (security_invoker = true) as
select e.id, e.order_id, e.cod_cliente, e.tipo, e.fecha_nueva, e.detectado_at,
       k.plantilla, k.idioma,
       c.business_name                                   as var_1_nombre,
       e.order_id::text                                  as var_2_pedido,
       to_char(e.fecha_nueva, 'DD/MM/YY')                as var_3_fecha,
       nullif(regexp_replace(coalesce(c.whatsapp,''), '[^0-9]', '', 'g'), '') as telefono
  from public.bot_pedido_eventos e
  join public.bot_evento_config k on k.tipo = e.tipo and k.activo and k.plantilla is not null
  left join public.customers c on c.id = e.customer_id
 where e.envio_estado = 'pendiente'
   and e.detectado_at >= now() - make_interval(hours => k.vigencia_horas);
revoke all on public.bot_eventos_para_enviar from anon, authenticated;

-- Cron (se programa aparte, con el sí de Luis). Offset para no caer en el minuto :00 (regla de
-- los 6 worker slots de LK):
--   select cron.schedule('bot-eventos-pedido', '7-59/10 * * * *',
--     $$select count(*) from public.bot_detectar_eventos_pedido(false, false)$$);
