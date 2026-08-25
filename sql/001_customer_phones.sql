-- Índice sobre customers.whatsapp para búsqueda rápida por teléfono
-- La tabla customers ya tiene la columna "whatsapp" — no creamos tabla separada.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- Índice para lookup por teléfono
create index if not exists idx_customers_whatsapp
  on customers(whatsapp)
  where whatsapp is not null and whatsapp != '';

-- Columna opt_out si no existe (para opt-out de notificaciones)
alter table customers
  add column if not exists wa_opt_out boolean not null default false;
