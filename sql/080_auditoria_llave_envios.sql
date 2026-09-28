-- 080 — Auditoría de la llave de envíos (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09): la llave (app_settings.wa_envio_automatico) se puede cambiar desde
-- el dashboard, SÓLO admins (lk_conversaciones → llave_set, requireAdmin). Cada cambio queda registrado acá
-- ANTES de aplicarse: si no se puede registrar, el cambio no se hace.
-- Solo service_role (RLS prendida, sin políticas): el front la lee a través de la edge.

create table if not exists public.wa_llave_cambios (
  id bigint generated always as identity primary key,
  modo_anterior text,
  modo_nuevo text not null check (modo_nuevo in ('0', 'prueba', '1')),
  usuario text not null,
  email text,
  creado_en timestamptz not null default now()
);
alter table public.wa_llave_cambios enable row level security;
revoke all on public.wa_llave_cambios from anon, authenticated;

-- Verificación: select * from wa_llave_cambios order by creado_en desc limit 5;
