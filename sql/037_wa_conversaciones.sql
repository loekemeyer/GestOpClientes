-- PaginaLK (kwkclwhmoygunqmlegrg) — Módulo Conversaciones (atención humana).
--
-- Se integra al bot real: el modo bot/humano vive en bot_conversaciones (lo respeta el
-- webhook lk_whatsapp-webhook vía bot_conv_get_modo) y el historial en bot_historial_chat.
-- Acá sólo agregamos estado del ticket + "leído" (UI) y el listado de conversaciones.

create table if not exists public.wa_human_control(
  phone text primary key,
  modo_humano boolean not null default false,   -- (legacy/UI) el modo real es bot_conversaciones.modo
  estado text not null default 'abierto',        -- abierto | pendiente | resuelto
  assigned_to text,
  last_read_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.wa_human_control enable row level security;

-- Listado: historial (bot_historial_chat) + modo (bot_conversaciones) + estado/leído (wa_human_control).
create or replace function public.wa_conversaciones_list()
returns table(phone text, last_body text, last_rol text, last_at timestamptz, total bigint,
  inbound_last_at timestamptz, modo text, agente text, modo_expira_en timestamptz,
  estado text, unread bigint)
language sql stable security definer set search_path to 'public' as $$
  with agg as (
    select telefono as phone, max(creado_en) last_at, count(*) total,
      max(creado_en) filter (where rol='user') inbound_last_at
    from public.bot_historial_chat group by telefono
  )
  select a.phone,
    (select contenido from public.bot_historial_chat h where h.telefono=a.phone order by creado_en desc limit 1),
    (select rol from public.bot_historial_chat h where h.telefono=a.phone order by creado_en desc limit 1),
    a.last_at, a.total, a.inbound_last_at,
    coalesce(bc.modo,'bot'), bc.agente_nombre, bc.modo_expira_en,
    coalesce(hc.estado,'abierto'),
    (select count(*) from public.bot_historial_chat h where h.telefono=a.phone and h.rol='user'
       and (hc.last_read_at is null or h.creado_en > hc.last_read_at))
  from agg a
  left join public.bot_conversaciones bc on bc.telefono=a.phone
  left join public.wa_human_control hc on hc.phone=a.phone
  order by a.last_at desc;
$$;

-- Seguridad del envío humano: 1 = sólo a números de la lista blanca (wa_envio_contactos).
insert into public.app_settings(key,value) values ('wa_human_send_whitelist_only','1')
  on conflict (key) do nothing;
