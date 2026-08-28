-- 032_wa_factura_consolidada.sql
-- Consolidación de facturas por cliente + día + línea (LK / Chef) para el aviso
-- "tu pedido está listo, acá tu factura" con PDF combinado.
--
-- Un pedido grande se divide en múltiples facturas. Como la factura no trae
-- número de pedido (NP), se agrupan por CUIT (cliente real) + día + fuente.
-- Esta tabla es el control/idempotencia: una fila por (source, cuit, fecha).
--
-- Fuentes de facturas (proyecto GP hrxfctzncixxqmpfhskv):
--   lk   -> schema isis_lk / bucket isis-lk
--   chef -> schema isis_ch / bucket isis-ch  (aún sin datos)
--
-- Puente cliente -> teléfono: contraparte_cuit  ==  customers.cuit  -> customers.whatsapp
-- Completitud: PPP (ppp_programacion) vs facturado (virgilio.facturacion_np).

create table if not exists public.wa_factura_consolidada (
  id             bigserial primary key,
  source         text        not null,                 -- 'lk' | 'chef'
  cuit           text        not null,
  cod_cliente    text,                                  -- customers.cod_cliente (si se resolvió)
  business_name  text,
  fecha          date        not null,                  -- día de consolidación
  factura_ids    bigint[]    not null default '{}',     -- ids en isis_<source>.documentos
  comprobantes   text[]      not null default '{}',     -- comprobante_id legibles
  n_facturas     int         not null default 0,
  total_sum      numeric     not null default 0,
  np_esperados   int,                                   -- PPP (null = aún no evaluado)
  np_facturados  int,
  pdf_path       text,                                  -- storage_path del PDF combinado
  estado         text        not null default 'pending',
    -- pending | complete | held_multisource | sent | error
  detalle        jsonb,                                 -- metadata (paths, totales por factura, etc.)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  sent_at        timestamptz,
  unique (source, cuit, fecha)
);

comment on table public.wa_factura_consolidada is
  'Consolidación de facturas por (source, cuit, fecha) para el aviso de pedido listo con PDF combinado. Idempotencia por unique(source,cuit,fecha).';

create index if not exists idx_wa_fc_estado       on public.wa_factura_consolidada (estado);
create index if not exists idx_wa_fc_fecha        on public.wa_factura_consolidada (fecha);
create index if not exists idx_wa_fc_cuit_fecha   on public.wa_factura_consolidada (cuit, fecha);
