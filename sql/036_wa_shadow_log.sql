-- PaginaLK (kwkclwhmoygunqmlegrg) — Log/dedupe del envío REAL redirigido ("barrido real").
--
-- lk_factura-check (modo 'grupo') registra acá cada grupo real procesado (enviado/retenido)
-- para no repetir el envío al número de redirección. Config del evento acotado:
--   wa_real_redirect_to   = número WhatsApp canónico destino (redirección)
--   wa_real_redirect_date = 'YYYY-MM-DD' del día habilitado (se apaga solo al día siguiente)

create table if not exists public.wa_shadow_log(
  id uuid primary key default gen_random_uuid(),
  group_key text unique,
  empresa text, cod_cliente text, dia date,
  n_facturas int, estado text, wamid text, total_sum numeric, redirect_to text,
  mensaje jsonb, created_at timestamptz not null default now()
);
alter table public.wa_shadow_log enable row level security;

-- Config del evento (setear la fecha al día que se quiere habilitar; dejar vacío = apagado).
insert into public.app_settings(key,value) values
  ('wa_real_redirect_to',''),
  ('wa_real_redirect_date','')
on conflict (key) do nothing;
