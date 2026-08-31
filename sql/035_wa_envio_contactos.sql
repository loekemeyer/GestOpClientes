-- PaginaLK (kwkclwhmoygunqmlegrg) — Lista blanca de envío WhatsApp ("Prueba de fuego").
--
-- IMPERATIVO DE SEGURIDAD: el bot SÓLO puede enviar mensajes a números de esta tabla.
-- Lista vacía = no envía a nadie. lk_factura-check valida el destino contra esta tabla
-- antes de llamar a la Meta Cloud API; sin match → estado 'held_no_whitelist' (no envía).
-- El front (docs/index.html, módulo "Prueba de fuego") agrega/saca contactos vía
-- lk_notif-sim (contact_add/remove/list), que normaliza el teléfono a formato AR canónico
-- (549 + área + número).

create table if not exists public.wa_envio_contactos (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,            -- formato canónico WhatsApp: 549 + área + número
  label text,                            -- nombre legible (opcional)
  created_at timestamptz not null default now()
);
alter table public.wa_envio_contactos enable row level security;

-- Emisor N8N (Phone Number ID de Meta) — lo usa lk_factura-check para el envío real.
insert into public.app_settings(key,value) values ('wa_phone_number_id','918089688061759')
  on conflict (key) do update set value=excluded.value;
