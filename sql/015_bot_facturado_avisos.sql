-- Dedup de avisos proactivos "pedido facturado / mañana sale" (uno por NP).
-- Lo usa la Edge Function lk_notif-facturado (disparada por Virgilio al tildar "facturó").
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg).

create table if not exists public.bot_facturado_avisos (
  np          text primary key,          -- NP de Virgilio (dedup: un aviso por pedido)
  cod_cliente text,
  total       numeric,                    -- total con IVA que se avisó
  created_at  timestamptz not null default now()
);

alter table public.bot_facturado_avisos enable row level security;

drop policy if exists service_role_all on public.bot_facturado_avisos;
create policy service_role_all on public.bot_facturado_avisos
  for all using (auth.role() = 'service_role');
