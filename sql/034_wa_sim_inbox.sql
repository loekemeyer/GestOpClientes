-- 034_wa_sim_inbox.sql — PaginaLK (kwkclwhmoygunqmlegrg). Ya aplicado.
-- Bandeja del módulo de prueba "Avisos automáticos": acá aterriza el mensaje que el
-- pipeline de facturación mandaría por WhatsApp (desvío mientras el bot no está
-- conectado al número). Lo llena lk_factura-check.
create table if not exists public.wa_sim_inbox (
  id            bigint generated always as identity primary key,
  source        text,
  grupo_key     text,
  cuit          text,
  cod_cliente   text,
  business_name text,
  fecha         date,
  n_facturas    integer,
  total_sum     numeric,
  metodo        text,
  estado        text not null default 'delivered',  -- delivered | held_multisource | held_metodo_mixto
  mensaje       jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists wa_sim_inbox_created_idx on public.wa_sim_inbox (created_at desc);
alter table public.wa_sim_inbox enable row level security;  -- sólo service_role (edge functions)

-- Modo de envío del pipeline de facturación: 'modulo' (chat de prueba) | 'whatsapp' (real).
insert into public.app_settings(key, value) values ('wa_factura_envio_modo', 'modulo')
on conflict (key) do nothing;
