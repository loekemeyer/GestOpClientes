-- Borradores de pedido en curso por WhatsApp
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

create table if not exists wa_order_draft (
  id          bigint generated always as identity primary key,
  phone       text not null unique,        -- 1 draft activo por teléfono
  customer_id uuid not null references customers(id),
  items       jsonb not null default '[]', -- [{product_id, cod, description, cajas, uxb, unit_price}]
  status      text not null default 'building',  -- building / confirming / submitted / expired
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index idx_wa_order_draft_phone on wa_order_draft(phone);

-- Auto-expirar drafts viejos (30 min sin actividad)
-- Correr con pg_cron cada 5 min
create or replace function wa_expire_old_drafts()
returns void as $$
begin
  update wa_order_draft
  set status = 'expired'
  where status in ('building', 'confirming')
    and updated_at < now() - interval '30 minutes';
end;
$$ language plpgsql security definer;

-- Trigger updated_at
create or replace function trg_wa_order_draft_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger wa_order_draft_updated
  before update on wa_order_draft
  for each row execute function trg_wa_order_draft_updated();

-- RLS
alter table wa_order_draft enable row level security;

create policy "service_role_all" on wa_order_draft
  for all using (auth.role() = 'service_role');
