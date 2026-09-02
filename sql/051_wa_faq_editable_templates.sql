-- 051 — Plantillas de FAQ editables desde el front + estándar de tokens
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
--
-- Objetivo:
--   1. Permitir que un usuario del dashboard (anon, gateado por Google OAuth a
--      nivel app) edite las respuestas de wa_faq desde la pestaña
--      "Preguntas frecuentes".
--   2. Definir un ESTÁNDAR de placeholders para las partes de la plantilla que
--      el bot completa con datos de la DB en runtime: tokens {{snake_case}}.
--   3. Catalogar qué tokens existen por tipo de lookup, para que el front
--      ofrezca "insertar dato" y renderice los tokens como chips.
--
-- Estándar de token:
--   {{token}}         → doble llave, snake_case, minúsculas.
--   is_block = false  → valor único (ej: {{descuento_volumen}} → "12").
--   is_block = true   → bloque multilínea que arma el backend
--                       (ej: {{lista_pedidos}} → varias filas de pedidos).
--
-- Idempotente: se puede correr varias veces sin efectos duplicados.

-- ============================================================
-- 1. Catálogo de tokens por tipo de lookup
-- ============================================================
create table if not exists wa_faq_lookup_tokens (
  id          bigint generated always as identity primary key,
  db_lookup_type text not null,          -- 'order_status', 'customer_discount', etc. '_global' = aplica a todas
  token       text not null,             -- nombre del token sin llaves (ej: 'nombre_cliente')
  label       text not null,             -- nombre legible (ej: 'Nombre del cliente')
  descripcion text,                       -- qué dato completa y de dónde sale
  is_block    boolean not null default false,
  ejemplo     text,                       -- valor de ejemplo para preview en el front
  sort_order  int not null default 100,
  created_at  timestamptz default now(),
  unique (db_lookup_type, token)
);

comment on table wa_faq_lookup_tokens is
  'Catálogo de tokens {{...}} que el bot reemplaza en las plantillas de wa_faq con datos de la DB.';

alter table wa_faq_lookup_tokens enable row level security;

drop policy if exists "tokens_service_all" on wa_faq_lookup_tokens;
create policy "tokens_service_all" on wa_faq_lookup_tokens
  for all using (auth.role() = 'service_role');

drop policy if exists "tokens_anon_read" on wa_faq_lookup_tokens;
create policy "tokens_anon_read" on wa_faq_lookup_tokens
  for select using (auth.role() = 'anon');

-- Seed del catálogo (idempotente vía ON CONFLICT)
insert into wa_faq_lookup_tokens (db_lookup_type, token, label, descripcion, is_block, ejemplo, sort_order) values
  ('_global',           'nombre_cliente',    'Nombre del cliente',      'Razón social del cliente identificado (customers.business_name).', false, 'Kiosco Don Pedro',              10),
  ('order_status',      'nombre_cliente',    'Nombre del cliente',      'Razón social del cliente identificado.',                          false, 'Kiosco Don Pedro',              10),
  ('order_status',      'lista_pedidos',     'Lista de pedidos',        'Bloque que arma el sistema con los últimos pedidos y su estado.', true,  '1️⃣ NP-123 (01/09) — 🚚 programado', 20),
  ('customer_discount', 'nombre_cliente',    'Nombre del cliente',      'Razón social del cliente identificado.',                          false, 'Kiosco Don Pedro',              10),
  ('customer_discount', 'descuento_volumen', 'Descuento por volumen',   'Porcentaje de descuento por volumen del cliente (customers.discount).', false, '12',                          20),
  ('product_price',     'nombre_cliente',    'Nombre del cliente',      'Razón social del cliente identificado.',                          false, 'Kiosco Don Pedro',              10),
  ('product_price',     'articulo',          'Artículo',                'Descripción del producto encontrado.',                            false, 'Abrelatas rojo',                20),
  ('product_price',     'codigo',            'Código de artículo',      'Código del producto.',                                            false, 'AB-102',                        30),
  ('product_price',     'precio_sin_iva',    'Precio sin IVA',          'Precio de lista sin IVA (calculado por el sistema).',             false, '1.500',                         40),
  ('product_price',     'precio_con_iva',    'Precio con IVA',          'Precio con IVA 21% (calculado por el sistema).',                  false, '1.815',                         50),
  ('product_price',     'precio_final',      'Precio con desc. web',    'Precio con IVA menos 2% web (calculado por el sistema).',         false, '1.779',                         60),
  ('product_stock',     'articulo',          'Artículo',                'Descripción del producto encontrado.',                            false, 'Abrelatas rojo',                20),
  ('product_stock',     'codigo',            'Código de artículo',      'Código del producto.',                                            false, 'AB-102',                        30),
  ('product_stock',     'stock',             'Stock disponible',        'Unidades disponibles (calculado por el sistema).',                false, '24',                            40),
  ('seller_contact',    'nombre_vendedor',   'Nombre del vendedor',     'Nombre del vendedor asignado al cliente.',                        false, 'Juan Pérez',                    20),
  ('product_search',    'lista',             'Lista de productos',      'Bloque con los productos encontrados que arma el sistema.',       true,  '• AB-102 Abrelatas rojo',       20),
  ('product_search',    'marca',             'Marca',                   'Marca consultada por el cliente.',                                false, 'Tramontina',                    30),
  ('order_status',      'fecha',             'Fecha de entrega/programación', 'Fecha estimada del pedido (calculada por el sistema).',     false, '15/09/2026',                    30),
  ('order_status',      'fecha_disponible',  'Fecha disponible',        'Fecha a partir de la cual se puede retirar.',                     false, '15/09/2026',                    40),
  ('order_status',      'fecha_programada',  'Fecha programada',        'Fecha de programación del pedido.',                               false, '15/09/2026',                    50)
on conflict (db_lookup_type, token) do update
  set label = excluded.label,
      descripcion = excluded.descripcion,
      is_block = excluded.is_block,
      ejemplo = excluded.ejemplo,
      sort_order = excluded.sort_order;

-- ============================================================
-- 2. Permitir UPDATE de wa_faq desde el front (anon)
--    La app está gateada por Google OAuth a nivel aplicación
--    (mismo criterio que las tablas wa_agente_*).
-- ============================================================
drop policy if exists "anon_update" on wa_faq;
create policy "anon_update" on wa_faq
  for update using (auth.role() = 'anon')
  with check (auth.role() = 'anon');

-- ============================================================
-- 3. Normalizar placeholders viejos al estándar {{token}}
--    (varios usaban [corchetes], {llave simple} o *----------*)
-- ============================================================

-- Descuento: dejar bot_response tokenizado y alineado con el output real del backend
update wa_faq set bot_response =
'{{nombre_cliente}}, tus descuentos son:
📦 *Por volumen*: {{descuento_volumen}}%
💻 *Por compra web*: 2% adicional
💰 *Por pago*:
  • Contado (0-14 días): 25%
  • 30 días: 20%
  • 60 días: 10%
  • 90 días: 5%

Estos se aplican sobre el precio base de la web. 💡'
where db_lookup_type = 'customer_discount' and is_active;

-- Fechas: [fecha] / [fecha_programada] / {fecha_disponible} → {{...}}
update wa_faq set bot_response = replace(bot_response, '[fecha]', '{{fecha}}') where bot_response like '%[fecha]%';
update wa_faq set bot_response = replace(bot_response, '[fecha_programada]', '{{fecha_programada}}') where bot_response like '%[fecha_programada]%';
update wa_faq set bot_response = replace(bot_response, '{fecha_disponible}', '{{fecha_disponible}}') where bot_response like '%{fecha_disponible}%';

-- Nombres de token de una sola llave → doble llave
update wa_faq set bot_response = replace(bot_response, '{nombre}', '{{nombre_vendedor}}') where bot_response like '%{nombre}%';
update wa_faq set bot_response = replace(bot_response, '{lista}', '{{lista}}') where bot_response like '%{lista}%';
update wa_faq set bot_response = replace(bot_response, '{marca}', '{{marca}}') where bot_response like '%{marca}%';

-- Líneas de guiones (relleno manual) en respuestas institucionales → {{fecha}}
update wa_faq set institutional_response = regexp_replace(institutional_response, '\*-{3,}\*', '{{fecha}}', 'g')
  where institutional_response ~ '\*-{3,}\*';
