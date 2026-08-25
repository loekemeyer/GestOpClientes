-- Cola de mensajes salientes WhatsApp
-- Patrón copiado de telegram_outbox (Virgilio)
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

create table if not exists wa_outbox (
  id              bigint generated always as identity primary key,
  phone           text not null,
  body            text,                     -- texto libre (null si es template)
  template_name   text,                     -- nombre template Meta (null si es texto)
  template_params jsonb,                    -- parámetros del template
  status          text not null default 'pending',  -- pending / sent / failed
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,
  created_at      timestamptz default now(),
  sent_at         timestamptz,
  error           text,
  customer_id     bigint references customers(id)
);

create index idx_wa_outbox_status on wa_outbox(status) where status = 'pending';
create index idx_wa_outbox_created on wa_outbox(created_at);

-- RLS
alter table wa_outbox enable row level security;

create policy "service_role_all" on wa_outbox
  for all using (auth.role() = 'service_role');
