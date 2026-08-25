-- Log de conversaciones WhatsApp (auditoría)
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

create table if not exists wa_conversations (
  id          bigint generated always as identity primary key,
  phone       text not null,
  direction   text not null,          -- 'in' / 'out'
  body        text,
  msg_type    text default 'text',    -- text / template / document / audio
  wa_msg_id   text,                   -- ID de Meta para dedup
  customer_id bigint references customers(id),
  intent      text,                   -- intent detectado (consulta_pedido, nuevo_pedido, etc)
  created_at  timestamptz default now()
);

create index idx_wa_conv_phone on wa_conversations(phone, created_at desc);
create index idx_wa_conv_customer on wa_conversations(customer_id, created_at desc);
create unique index idx_wa_conv_dedup on wa_conversations(wa_msg_id) where wa_msg_id is not null;

-- RLS
alter table wa_conversations enable row level security;

create policy "service_role_all" on wa_conversations
  for all using (auth.role() = 'service_role');
