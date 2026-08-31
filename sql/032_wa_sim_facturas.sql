-- 032_wa_sim_facturas.sql
-- Simulador de "avisos automáticos por facturación" para el dashboard.
-- Reproduce el rastreo de consolidación (esperar a que TODAS las facturas de un
-- cliente/pedido impacten antes de mandar un solo aviso) SIN tocar las tablas de
-- producción (wa_factura_consolidada, bot_facturado_avisos, wa_outbox) ni enviar WhatsApp.
--
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg). Idempotente.

create table if not exists public.wa_sim_facturas (
  sim_id         uuid primary key default gen_random_uuid(),
  source         text not null default 'lk',
  cod_cliente    text,
  business_name  text,
  cuit_masked    text,
  fecha          date not null default current_date,

  -- método de pago elegido para el pedido (define descuento y plantilla)
  metodo         text not null default 'no_decidido',
  grupo          text not null default 'contado',   -- contado | credito | echeq

  -- rastreo de consolidación (el corazón de la prueba)
  np_esperados   integer not null default 1,
  np_facturados  integer not null default 0,

  -- facturas que fueron impactando (arrays paralelos, patrón wa_factura_consolidada)
  np_list        text[]    not null default '{}',
  comprobantes   text[]    not null default '{}',
  totales        numeric[] not null default '{}',
  total_sum      numeric   not null default 0,

  -- waiting | complete | held_metodo_mixto | sent_sim
  estado         text not null default 'waiting',
  mensaje        jsonb,                              -- plan de mensaje armado al completar

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  sent_at        timestamptz
);

create index if not exists wa_sim_facturas_estado_idx  on public.wa_sim_facturas (estado);
create index if not exists wa_sim_facturas_created_idx  on public.wa_sim_facturas (created_at desc);

comment on table public.wa_sim_facturas is
  'Simulador aislado de avisos automáticos por facturación (dashboard). No se envía WhatsApp ni se tocan tablas de producción. np_esperados/np_facturados replican el rastreo de consolidación de wa_factura_consolidada.';

-- Datos de simulación → no exponer por anon. La edge function usa service_role.
alter table public.wa_sim_facturas enable row level security;
-- (sin policies: sólo service_role puede leer/escribir; el dashboard entra vía edge function)
