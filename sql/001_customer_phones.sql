-- Vinculación teléfono WhatsApp ↔ cliente
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

create table if not exists customer_phones (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers(id),
  phone       text   not null unique,   -- formato canónico (ej: 1155551234)
  verified    boolean default false,
  opt_out     boolean default false,    -- cliente pidió no recibir mensajes
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index idx_customer_phones_phone on customer_phones(phone);
create index idx_customer_phones_customer on customer_phones(customer_id);

-- Trigger updated_at
create or replace function trg_customer_phones_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger customer_phones_updated
  before update on customer_phones
  for each row execute function trg_customer_phones_updated();

-- RLS
alter table customer_phones enable row level security;

-- Service role full access (edge functions)
create policy "service_role_all" on customer_phones
  for all using (auth.role() = 'service_role');
