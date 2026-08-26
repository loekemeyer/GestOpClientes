-- ============================================================
-- 009_wa_faq_web_first.sql
-- Patrón "Web First" + Product Match para wa_faq
-- ============================================================
-- Agrega columnas para la respuesta "primero probá en la web"
-- y la flag de product match. Actualiza registros existentes
-- e inserta las preguntas del Top 30 que faltaban.
--
-- Lógica Web First:
--   1. Bot envía web_first_response (link a la web + instrucciones)
--   2. Si el cliente dice "no quiero" / "prefiero por acá" / similar
--      → bot usa bot_response (flujo semi-auto por chat)
--   3. fallback_label describe la condición de fallback
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Nuevas columnas
-- ─────────────────────────────────────────────────────────────
alter table wa_faq
  add column if not exists web_first_response   text,         -- respuesta inicial derivando a la web
  add column if not exists fallback_label       text,         -- "Si el cliente prefiere por chat" (para el bot)
  add column if not exists requires_product_match boolean not null default false;  -- usa wa_product_match

comment on column wa_faq.web_first_response is
  'Respuesta inicial que ofrece la opción web/self-service. NULL = no aplica Web First.';
comment on column wa_faq.fallback_label is
  'Descripción del trigger de fallback (ej: "si el cliente prefiere por chat"). NULL = no aplica.';
comment on column wa_faq.requires_product_match is
  'True si la pregunta requiere identificar un producto con wa_product_match.';

-- ─────────────────────────────────────────────────────────────
-- 2. Actualizar registros existentes con Web First
-- ─────────────────────────────────────────────────────────────

-- #2 — ¿Qué descuento tengo? (descuentos_promociones)
-- Requiere verificar si el teléfono está en customer_phones.
-- Si es cliente: ofrecer la web con su usuario.
-- Si no es cliente: ofrecer hacerse cliente.
update wa_faq set
  web_first_response = E'Tu descuento lo podés ver directamente en la página web, donde todos los precios ya aparecen con tu bonificación aplicada. 📋\n🔗 [link a la página web]\n\n{{SI_CLIENTE}} Ingresá con tu usuario y contraseña. Si no los tenés, avisame y te los envío.\n{{SI_NO_CLIENTE}} Si no tenés usuario, y querés hacerte cliente, avisame y procederemos con el alta.',
  fallback_label = 'Si el cliente prefiere consultar por chat'
where category = 'descuentos_promociones'
  and subcategory is null;

-- #3 — ¿Tienen stock de X? (stock_disponibilidad)
update wa_faq set
  web_first_response = E'Podés ver el stock actualizado en tiempo real desde la web: 📦\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Buscá el producto por nombre o código\n3. El stock disponible aparece en cada artículo\n\nSi necesitás tu usuario y clave, avisame. 😊',
  fallback_label = 'Si el cliente prefiere consultar por chat',
  requires_product_match = true
where category = 'stock_disponibilidad';

-- #4 — Novedad de mi pedido (estado_demora_pedido)
update wa_faq set
  web_first_response = E'Podés ver el estado de tus pedidos desde la web: 📋\n🔗 loekemeyer.com → "Mis Pedidos"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Andá a "Mis Pedidos"\n3. Ahí ves el estado actualizado de cada pedido\n\nSi necesitás tu usuario y clave, avisame. 😊',
  fallback_label = 'Si el cliente prefiere consultar por chat'
where category = 'estado_demora_pedido';

-- #5 — ¿Cuándo sale mi pedido? (transporte_fecha_entrega)
update wa_faq set
  web_first_response = E'Podés ver la fecha programada de tu pedido desde la web: 🚚\n🔗 loekemeyer.com → "Mis Pedidos"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Andá a "Mis Pedidos"\n3. Cada pedido muestra la fecha estimada de entrega\n\nRecordá que la fecha de salida es aproximada y puede variar 2-3 días. Si necesitás tu clave, avisame. 😊',
  fallback_label = 'Si el cliente prefiere consultar por chat'
where category = 'transporte_fecha_entrega';

-- #8 — Quiero hacer un pedido (hacer_modificar_pedido, nuevo_pedido)
update wa_faq set
  web_first_response = E'¡Genial! Podés cargar tu pedido directamente desde nuestra web, es más rápido y cómodo: 🛒\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Buscá los productos que necesitás\n3. Agregá las cantidades al carrito\n4. Confirmá el pedido\n\nLos precios ya tienen tu descuento aplicado + 2% extra por usar la web. Si necesitás tu usuario y clave, avisame. 😊',
  fallback_label = 'Si el cliente prefiere hacer el pedido por chat',
  requires_product_match = true
where category = 'hacer_modificar_pedido'
  and subcategory = 'nuevo_pedido';

-- #11 — ¿Cuánto sale X? (precios_lista, consulta_precio_articulo)
update wa_faq set
  web_first_response = E'Podés consultar todos los precios con tu descuento aplicado en nuestra página web: 💰\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Buscá el producto por nombre o categoría\n3. El precio ya aparece con tu descuento aplicado\n\nTambién podés ver stock disponible en tiempo real. Si necesitás tu usuario y clave, avisame. 😊',
  fallback_label = 'Si el cliente prefiere consultar por chat',
  requires_product_match = true
where category = 'precios_lista'
  and subcategory = 'consulta_precio_articulo';

-- #15 — Necesito factura/remito (facturacion_comprobante)
update wa_faq set
  web_first_response = E'Podés descargar tus facturas y remitos directamente desde la web: 🧾\n🔗 loekemeyer.com → "Mis Pedidos" → "Comprobantes"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Andá a "Mis Pedidos" o "Comprobantes"\n3. Buscá el pedido y hacé clic en "Descargar factura/remito"\n\nEstán disponibles en PDF para imprimir o guardar. Si necesitás tu usuario, avisame. 😊',
  fallback_label = 'Si el cliente prefiere recibirla por chat'
where category = 'facturacion_comprobante';

-- #22 — Agregar al pedido (hacer_modificar_pedido, modificar_pedido)
update wa_faq set
  web_first_response = E'Si tu pedido todavía no fue despachado, podés modificarlo desde la web: ✏️\n🔗 loekemeyer.com → "Mis Pedidos"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Andá a "Mis Pedidos"\n3. Buscá el pedido y hacé clic en "Editar"\n4. Agregá o quitá los productos que necesites\n5. Confirmá los cambios\n\nSi el pedido ya fue despachado, no se puede modificar. Si necesitás tu usuario, avisame. 😊',
  fallback_label = 'Si el cliente prefiere modificarlo por chat',
  requires_product_match = true
where category = 'hacer_modificar_pedido'
  and subcategory = 'modificar_pedido';

-- #28 — Quiero ser cliente (web_registro_contrasena, alta_cliente)
update wa_faq set
  web_first_response = E'¡Qué bueno que te interese! Podés registrarte como cliente mayorista directamente desde nuestra web: 🤝\n🔗 loekemeyer.com → "Registro mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá al formulario de registro\n2. Completá los datos de tu empresa: nombre, CUIT, rubro\n3. Cargá la constancia de inscripción AFIP\n4. Enviá la solicitud\n\nUn vendedor te va a contactar en 24hs para completar tu alta y asignarte las condiciones comerciales. 😊',
  fallback_label = 'Si el cliente prefiere registrarse por chat'
where category = 'web_registro_contrasena'
  and subcategory = 'alta_cliente';

-- ─────────────────────────────────────────────────────────────
-- 3. Insertar preguntas del Top 30 que faltaban
-- ─────────────────────────────────────────────────────────────

insert into wa_faq (
  category, category_label, subcategory, automation_level,
  sample_question, keywords, bot_response,
  requires_db_lookup, db_lookup_type, priority,
  frequency_count, frequency_pct,
  web_first_response, fallback_label, requires_product_match,
  notes
) values

-- #13 — ¿Hacen envíos a X zona?
(
  'logistica',
  'Logística',
  'zona_envio',
  'full_auto',
  '¿Hacen envíos a X zona?',
  ARRAY['envío', 'envio', 'hacen envíos', 'llegan a', 'envían a', 'zona', 'interior', 'provincia', 'reparto', 'cobertura', 'envian a'],
  E'🚚 ¡Hacemos envíos a todo el país!\n\n📍 *CABA y GBA*: entrega propia (7-15 días hábiles)\n📍 *Interior*: por expreso a cargo del cliente\n\nEl monto mínimo para envío es $500.000.\nPara retiro en depósito (Virgilio 2788, Villa Devoto) el mínimo es $300.000.\n\n¿A qué zona necesitás que te enviemos?',
  false,
  null,
  55,
  21,
  9.38,
  null, null, false,
  'Respuesta fija. Los expresos para interior los coordina el cliente.'
),

-- #16 — ¿Tienen financiación / cuotas?
(
  'pago_financiacion',
  'Pago / Financiación',
  null,
  'full_auto',
  '¿Tienen financiación / cuotas?',
  ARRAY['financiación', 'financiacion', 'cuotas', 'en cuotas', 'pagar en cuotas', 'financiar', 'plazo', 'crédito', 'credito'],
  E'💳 Formas de pago disponibles:\n\n• Transferencia bancaria\n• Cheques (consultar condiciones con tu vendedor)\n• Contado efectivo\n• E-cheq\n\nPara financiación especial o cuotas, consultá con tu vendedor asignado que te arma la mejor opción. 📞',
  false,
  null,
  50,
  18,
  8.04,
  null, null, false,
  'Respuesta fija. Para financiación especial derivar al vendedor.'
),

-- #17 — Quiero hablar con mi vendedor
(
  'contacto_vendedor',
  'Contacto Vendedor',
  null,
  'semi_auto',
  'Quiero hablar con mi vendedor',
  ARRAY['vendedor', 'hablar con vendedor', 'pasame con', 'mi vendedor', 'quien me atiende', 'quiero hablar', 'asesor', 'representante', 'contacto vendedor'],
  E'Tu vendedor es {nombre}. Ya le avisé que necesitás hablar. Te va a contactar a la brevedad. 📱',
  true,
  'seller_contact',
  65,
  17,
  7.59,
  null, null, false,
  'Consultar customers → seller_id → whatsapp_vendedores. Notificar al vendedor vía wa_outbox.'
),

-- #19 — Consulta por producto específico
(
  'consulta_producto',
  'Producto',
  'consulta_especifica',
  'semi_auto',
  'Consulta por producto específico',
  ARRAY['qué modelos', 'que modelos', 'qué opciones', 'que opciones', 'qué tienen en', 'que tienen en', 'línea', 'linea', 'variedad', 'opciones de', 'modelos de'],
  E'Tenemos estas opciones:\n{lista de productos con precios}\n¿Querés ver más opciones o agregar alguna al pedido?',
  true,
  'product_search',
  52,
  15,
  6.70,
  E'Podés explorar todo nuestro catálogo con fotos, precios y stock desde la web: 🔎\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Usá el buscador o navegá por categoría/marca\n3. Filtrá por medida, marca o tipo de producto\n4. Cada producto muestra precio con tu descuento y disponibilidad\n\nAsí podés comparar opciones tranquilo. Si necesitás tu usuario, avisame. 😊',
  'Si el cliente prefiere consultar por chat',
  true,
  'Usa wa_product_match para buscar por categoría/marca/medida. Devuelve top 5.'
),

-- #23 — ¿Hay faltante en mi pedido?
(
  'reclamo',
  'Reclamo',
  'faltante',
  'needs_human',
  '¿Hay faltante en mi pedido?',
  ARRAY['faltante', 'falta', 'incompleto', 'me falta', 'no llegó todo', 'no llego todo', 'faltaron', 'pedido incompleto'],
  E'Lamento el inconveniente. Voy a verificar tu pedido y derivar al equipo para resolverlo.\n\nPor favor indicame:\n📦 N° de pedido o factura\n🔢 Qué artículo/s faltan\n\nUn vendedor se va a comunicar con vos a la brevedad para resolverlo.',
  true,
  'order_detail',
  48,
  11,
  4.91,
  null, null, false,
  'Siempre derivar a humano. El bot recolecta datos iniciales.'
),

-- #24 — ¿Tienen X marca?
(
  'catalogo_marca',
  'Catálogo',
  'consulta_marca',
  'semi_auto',
  '¿Tienen X marca?',
  ARRAY['marca', 'trabajan con', 'venden', 'tienen productos de', 'manejan', 'distribuyen'],
  E'Sí, trabajamos con {marca}. Tenemos {N} productos en: {categorías}. ¿Querés que te pase opciones de alguna categoría?',
  true,
  'product_search',
  47,
  10,
  4.46,
  E'Podés ver todas las marcas y productos disponibles en nuestro catálogo web: 🏷️\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Usá el filtro de "Marca" en el buscador\n3. Seleccioná la marca que te interesa\n4. Vas a ver todos los productos disponibles con precios y stock\n\nSi necesitás tu usuario, avisame. 😊',
  'Si el cliente prefiere consultar por chat',
  true,
  'Usa wa_product_match con alias de tipo brand para buscar todos los productos de la marca.'
),

-- #26 — Necesito presupuesto formal
(
  'precios_lista',
  'Precios / Lista',
  'presupuesto_formal',
  'semi_auto',
  'Necesito presupuesto formal',
  ARRAY['presupuesto', 'cotización formal', 'cotizacion formal', 'cotización', 'cotizacion', 'presupuesto formal', 'cotizar', 'presupuestar'],
  E'Decime los productos y cantidades que necesitás y te armo el presupuesto con tus precios.\n\nTambién lo puedo enviar por email como PDF formal.',
  true,
  'product_search',
  46,
  9,
  4.02,
  E'Podés armar tu presupuesto directamente desde la web y descargarlo en PDF: 📄\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Agregá los productos y cantidades al carrito\n3. Antes de confirmar, hacé clic en "Descargar presupuesto"\n4. Se genera un PDF formal con tus precios y descuento\n\nEl presupuesto queda guardado para cuando quieras confirmarlo como pedido. Si necesitás tu usuario, avisame. 😊',
  'Si el cliente prefiere armarlo por chat',
  true,
  'Mismo flujo iterativo que hacer pedido (#8). Usa wa_product_match_with_price por cada item.'
),

-- #29 — ¿Aceptan Mercado Pago?
(
  'pago_mercadopago',
  'Pago / CBU',
  null,
  'full_auto',
  '¿Aceptan Mercado Pago?',
  ARRAY['mercado pago', 'mercadopago', 'mp', 'aceptan mercado pago'],
  E'Por el momento no aceptamos Mercado Pago como medio de pago.\n\nNuestras opciones son:\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques / E-cheq\n\n¿Necesitás los datos bancarios para transferir?',
  false,
  null,
  30,
  7,
  3.13,
  null, null, false,
  'Respuesta fija. Si algún día se acepta MP, actualizar.'
),

-- #30 — Cancelar/modificar pedido (registro separado del modificar_pedido existente)
(
  'cancelar_pedido',
  'Hacer Pedido',
  'cancelar',
  'semi_auto',
  'Quiero cancelar mi pedido',
  ARRAY['cancelar', 'anular', 'cancelar pedido', 'anular pedido', 'quiero cancelar', 'se puede anular', 'dar de baja'],
  E'Verifico el estado de tu pedido. Si está pendiente o confirmado, se puede cancelar. Si ya está en preparación o tránsito, no es posible.\n\n¿Me pasás el número de pedido?',
  true,
  'order_cancel',
  45,
  7,
  3.13,
  E'Si tu pedido todavía no fue despachado, podés cancelarlo o modificarlo desde la web: ❌\n🔗 loekemeyer.com → "Mis Pedidos"\n\n📝 Cómo hacerlo:\n1. Ingresá con tu CUIT y contraseña\n2. Andá a "Mis Pedidos"\n3. Buscá el pedido pendiente\n4. Hacé clic en "Editar" para modificar o "Cancelar" para anular\n\nSi el pedido ya está en preparación o tránsito, contactá a tu vendedor. Si necesitás tu usuario, avisame. 😊',
  'Si el cliente prefiere gestionarlo por chat',
  true,
  'Verificar status del pedido antes de cancelar. Solo pending/confirmed se pueden cancelar.'
);

-- ─────────────────────────────────────────────────────────────
-- 4. Actualizar función wa_faq_match para incluir campos nuevos
-- ─────────────────────────────────────────────────────────────

create or replace function wa_faq_match(p_text text)
returns table (
  faq_id                bigint,
  category              text,
  subcategory           text,
  automation_level      text,
  bot_response          text,
  web_first_response    text,
  fallback_label        text,
  requires_db_lookup    boolean,
  db_lookup_type        text,
  requires_product_match boolean,
  match_score           int
) as $$
begin
  return query
    select
      f.id as faq_id,
      f.category,
      f.subcategory,
      f.automation_level,
      f.bot_response,
      f.web_first_response,
      f.fallback_label,
      f.requires_db_lookup,
      f.db_lookup_type,
      f.requires_product_match,
      (
        select count(*)::int
        from unnest(f.keywords) as kw
        where lower(p_text) like '%' || lower(kw) || '%'
      ) as match_score
    from wa_faq f
    where f.is_active = true
    order by match_score desc, f.priority desc
    limit 5;
end;
$$ language plpgsql stable security definer;

comment on function wa_faq_match(text) is
  'Busca FAQ por keywords en texto libre. Devuelve top 5 con score, incluyendo web_first_response y flags de product match.';

-- ─────────────────────────────────────────────────────────────
-- 5. Vista helper: resumen del Top 30 con nivel de automatización
-- ─────────────────────────────────────────────────────────────

create or replace view v_wa_faq_summary as
select
  f.id,
  f.category_label,
  f.subcategory,
  f.sample_question,
  f.automation_level,
  f.frequency_count,
  f.frequency_pct,
  case when f.web_first_response is not null then true else false end as has_web_first,
  f.requires_product_match,
  f.requires_db_lookup,
  f.priority
from wa_faq f
where f.is_active = true
order by f.frequency_count desc, f.priority desc;

comment on view v_wa_faq_summary is
  'Resumen de FAQs activas ordenadas por frecuencia. Para dashboards y análisis.';
