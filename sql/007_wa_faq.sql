-- Preguntas frecuentes y respuestas predeterminadas para el bot WhatsApp
-- Fuente: análisis de 1739 conversaciones reales (Mayo-Dic 2025, Ene 2026)
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- ============================================================
-- TABLA: wa_faq
-- Almacena preguntas frecuentes categorizadas con respuestas
-- predeterminadas para que el bot responda automáticamente
-- o derive al vendedor según corresponda.
-- ============================================================

create table if not exists wa_faq (
  id                  bigint generated always as identity primary key,
  category            text not null,                  -- tema principal (ej: 'precios_lista')
  category_label      text not null,                  -- nombre legible (ej: 'Precios / lista')
  subcategory         text,                           -- subtema (ej: 'alta_cliente', 'acceso_web')
  automation_level    text not null default 'full_auto',
                      -- 'full_auto'    = bot responde solo, sin consultar DB ni humano
                      -- 'semi_auto'    = bot da respuesta parcial + consulta DB para completar
                      -- 'needs_human'  = bot registra y deriva a vendedor
  sample_question     text not null,                  -- pregunta representativa del cliente
  keywords            text[] not null default '{}',   -- palabras clave para matching de intent
  bot_response        text not null,                  -- respuesta corta para WA (max 4000 chars)
  institutional_response text,                        -- respuesta formal/institucional completa
  requires_db_lookup  boolean not null default false,  -- necesita datos del sistema para responder
  db_lookup_type      text,                           -- tipo: 'order_status', 'customer_discount', etc.
  priority            int not null default 50,         -- 1-100, mayor = revisar primero en matching
  frequency_count     int not null default 0,          -- cantidad de veces preguntada (histórico)
  frequency_pct       numeric(5,2) default 0,          -- porcentaje sobre total consultas
  is_active           boolean not null default true,
  notes               text,                           -- notas internas para el equipo
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Indices
create index idx_wa_faq_category on wa_faq(category);
create index idx_wa_faq_active on wa_faq(is_active) where is_active = true;
create index idx_wa_faq_automation on wa_faq(automation_level);
create index idx_wa_faq_priority on wa_faq(priority desc);

-- GIN index para búsqueda en keywords
create index idx_wa_faq_keywords on wa_faq using gin(keywords);

-- Trigger updated_at
create or replace function trg_wa_faq_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger wa_faq_updated
  before update on wa_faq
  for each row execute function trg_wa_faq_updated();

-- RLS
alter table wa_faq enable row level security;

create policy "service_role_all" on wa_faq
  for all using (auth.role() = 'service_role');

-- Acceso de lectura para anon (el bot puede leer sin service role si se necesita)
create policy "anon_read" on wa_faq
  for select using (auth.role() = 'anon' and is_active = true);


-- ============================================================
-- SEED DATA: Preguntas frecuentes extraídas del análisis
-- ============================================================

insert into wa_faq (
  category, category_label, subcategory, automation_level,
  sample_question, keywords, bot_response, institutional_response,
  requires_db_lookup, db_lookup_type, priority, frequency_count, frequency_pct, notes
) values

-- ────────────────────────────────────────────────────────────
-- 1. TRANSPORTE / FECHA DE ENTREGA  (19.2% — Top 1)
-- ────────────────────────────────────────────────────────────
(
  'transporte_fecha_entrega',
  'Transporte / fecha de entrega',
  null,
  'semi_auto',
  '¿Cuándo llega mi pedido? ¿Alguna novedad de mi entrega?',
  ARRAY['transporte', 'fecha de entrega', 'cuando llega', 'novedad del pedido', 'entrega', 'despacho', 'cuando sale', 'cuando despachan', 'envío', 'envio', 'fecha estimada', 'ya salio', 'ya salió', 'cuando me llega'],
  'Estoy consultando el estado de tu pedido. Tu pedido está programado para el día [fecha]. Tené en cuenta que la fecha de salida de nuestro centro de distribución es aproximada y puede variar 2 o 3 días. Te aviso apenas tenga la info actualizada.',
  E'Estimado Cliente:\nSu pedido ya fue programado para el día *----------*\nTenga en cuenta que la fecha en que saldrá su pedido de nuestro centro de distribución es aproximada y puede tener una diferencia de 2 o 3 días de lo informado.\nSaludos.\nDpto. de Ventas.',
  true,
  'order_status',
  95,
  43,
  19.20,
  'Requiere consultar orders + order_tracking para dar fecha real. Si no hay pedido activo, informar que no hay pedidos pendientes.'
),

-- ────────────────────────────────────────────────────────────
-- 2. HACER / MODIFICAR PEDIDO  (17.0% — Top 2)
-- ────────────────────────────────────────────────────────────
(
  'hacer_modificar_pedido',
  'Hacer / modificar pedido',
  'nuevo_pedido',
  'semi_auto',
  'Quiero hacer un pedido / pasar un pedido',
  ARRAY['hacer pedido', 'pasar pedido', 'nuevo pedido', 'quiero pedir', 'armar pedido', 'enviar pedido', 'orden de compra', 'cargar pedido', 'te paso pedido', 'quiero comprar', 'hacer un pedido'],
  'Podés hacer tu pedido de 2 formas:\n1️⃣ *Página Web*: Ingresá a loekemeyer.com con tu CUIT y contraseña\n2️⃣ *Por acá*: Decime los códigos y cantidades en cajas\n\nLa demora de entrega es de 7 a 15 días. La mercadería viaja solo con remito y la factura se envía por mail.',
  E'Te confirmamos la recepción del pedido. La demora de entrega es de 7 a 15 días. Viaja solo con remito y la factura se envía por mail.',
  true,
  'order_create',
  90,
  38,
  16.96,
  'Si el cliente envía códigos + cantidades, iniciar wa_order_draft. Si es modificación, buscar pedido activo.'
),

(
  'hacer_modificar_pedido',
  'Hacer / modificar pedido',
  'modificar_pedido',
  'needs_human',
  'Necesito modificar / agregar algo a mi pedido',
  ARRAY['modificar pedido', 'agregar al pedido', 'cambiar pedido', 'sacar del pedido', 'quitar', 'agregar artículo', 'sumar al pedido', 'cambio en el pedido'],
  'Tomo nota de la modificación. Voy a verificar el estado de tu pedido para confirmar si se puede modificar. Un vendedor te va a contactar para confirmar los cambios.',
  null,
  true,
  'order_modify',
  85,
  0,
  0,
  'Si el pedido ya está programado/facturado, no se puede modificar. Derivar siempre.'
),

-- ────────────────────────────────────────────────────────────
-- 3. RETIRO / DIRECCIÓN DEL DEPÓSITO  (15.2% — Top 3)
-- ────────────────────────────────────────────────────────────
(
  'retiro_deposito',
  'Retiro / dirección del depósito',
  'direccion',
  'full_auto',
  '¿Dónde y cuándo retiro mi pedido?',
  ARRAY['retiro', 'retirar', 'dirección', 'direccion', 'depósito', 'deposito', 'donde retiro', 'buscar pedido', 'pasar a buscar', 'retira', 'horario de retiro', 'donde queda', 'ubicación', 'ubicacion'],
  '📍 *Dirección de retiro:* Virgilio 2788, Villa Devoto, CABA\n🕐 *Horario:* Lunes a viernes de 10 a 12 hs y de 13 a 16 hs\n\nRecordá que si no retirás en la fecha acordada, el pedido se desarma al día siguiente.',
  E'Estimado Cliente:\n\nSu pedido ya pasó a programación.\n*Indíquenos fecha en que podrá retirarlo* a partir del día *----------*,\nen el horario de 10 a 12hs y 13 a 16hs.\nRecuerde que en caso de no ser retirado en la fecha que nos indica, el mismo será desarmado al día siguiente.\n\nHemos terminado de implementar un proceso que automatiza la programación, facturación y entrega de pedidos, lo que ha mejorado notablemente los plazos de entrega.\nPor correlatividad de sistema, no nos permite seguir armando pedidos si no se completaron la entrega del día anterior.\nPor ende, solo podemos armar pedidos y facturarlos si tenemos fecha exacta de retiro.\n\nEn caso de que sufrió algún acontecimiento que le impida cumplir con la fecha acordada, si nos avisa un día antes el sistema nos da la posibilidad de hacer un único cambio hasta dos días posteriores de la fecha acordada originalmente.\n\nAgradecemos sepan entender esta disposición que no podemos trasgredir.\n\nSaludos.\nDpto. de Ventas.',
  false,
  null,
  88,
  34,
  15.18,
  'Respuesta fija. Si el cliente pregunta cuándo puede retirar un pedido puntual, eso es semi_auto (necesita fecha de programación).'
),

(
  'retiro_deposito',
  'Retiro / dirección del depósito',
  'fecha_retiro',
  'semi_auto',
  '¿Para cuándo puedo programar el retiro de mi pedido?',
  ARRAY['programar retiro', 'fecha retiro', 'cuando puedo retirar', 'cuando esta listo', 'cuando lo busco'],
  'Tu pedido está en programación. ¿Para qué fecha podés pasar a retirarlo? Recordá que el horario es de 10 a 12 hs y de 13 a 16 hs en Virgilio 2788, Villa Devoto.',
  null,
  true,
  'order_status',
  82,
  0,
  0,
  'Requiere verificar que el pedido esté en estado "programado" antes de pedir fecha.'
),

-- ────────────────────────────────────────────────────────────
-- 4. WEB / REGISTRO / CONTRASEÑA  (8.5%)
-- ────────────────────────────────────────────────────────────
(
  'web_registro_contrasena',
  'Web / registro / contraseña',
  'alta_cliente',
  'semi_auto',
  'Quiero darme de alta como cliente / Soy nuevo',
  ARRAY['alta', 'nuevo cliente', 'darme de alta', 'registrarme', 'quiero ser cliente', 'empezar a comprar', 'como compro', 'primera vez'],
  'Para darte de alta como cliente necesitamos los siguientes datos:\n\n📋 *Razón social*\n👤 *Nombre de contacto*\n📱 *Teléfono*\n🔢 *CUIT*\n📧 *Mail*\n📍 *Dirección y localidad*\n🚚 *Expreso con el que trabajan* (dirección y teléfono)\n🏪 *Tipo de comercio* (Ej: Bazar, mayorista) y dimensión (Ej: 4x8=32m²)\n🌐 *Tiene venta web/página*\n📦 *Si ya vende nuestra mercadería*, indicar a quién le compra\n📢 *Si no la vende*, indicar de dónde conoce la marca\n\nUna vez aprobado por Gerencia, te enviamos la lista de precios.',
  E'Le pido los datos para el alta.\n\n·   Razón social\n·   Nombre de contacto\n·   Teléfono\n·   Cuit\n·   Mail\n·   Dirección\n·   Localidad\n·   Expreso con el que trabajan, dirección y teléfono del mismo (de corresponder)\n·   Tipo de comercio (Ej. Bazar, local mayorista, distribuidor) y dimensión del mismo (Ej. 4mt. x 8mt. = 32mt2.)\n·   Tiene venta web (pagina):\n·   En caso de ya vender nuestra mercadería, indicar a quien le compran.\n·   En caso de no vender nuestra mercadería, indicar de donde conocen la marca.\n\nGracias',
  false,
  null,
  80,
  19,
  8.48,
  'El bot recolecta los datos y los envía al vendedor para aprobación de gerencia.'
),

(
  'web_registro_contrasena',
  'Web / registro / contraseña',
  'acceso_web',
  'semi_auto',
  'No puedo entrar a la web / Necesito mi contraseña',
  ARRAY['contraseña', 'contrasena', 'password', 'no puedo entrar', 'no me deja entrar', 'clave', 'acceso', 'login', 'no funciona la web', 'olvidé contraseña', 'olvide clave', 'resetear', 'no me acuerdo'],
  'Para ingresar a loekemeyer.com, hacé clic en "Pedidos Mayorista" e iniciá sesión con tu CUIT.\n\n¿Cuál es tu CUIT? Así verifico tu acceso y te envío la contraseña.',
  E'Estimados clientes,\n\nCon el objetivo de mejorar su experiencia de compra, desarrollamos una nueva plataforma online para que puedan enviarnos sus pedidos de forma más ágil y sencilla.\n\nA través de Loekemeyer.com podrán gestionar su reposición con mayor facilidad, acceder a nuevos productos, consultar su historial de compras desde 2020 en adelante y repetir pedidos en un solo paso, sugerencias de compras por IA, entre otras funcionalidades.\n\nPara acceder, ingresen a Loekemeyer.com, hagan clic en "Pedidos Mayorista" e inicien sesión con su CUIT y contraseña detallada:\n\n*Tu Contraseña es --------*\n\nQuedamos a disposición para cualquier consulta.\n\nSaludos cordiales,\nEquipo Loekemeyer',
  true,
  'customer_password',
  78,
  0,
  0,
  'Requiere buscar el customer por CUIT y enviar su contraseña. NUNCA enviar contraseñas sin verificar CUIT primero.'
),

-- ────────────────────────────────────────────────────────────
-- 5. DESCUENTOS / PROMOCIONES  (8.0%)
-- ────────────────────────────────────────────────────────────
(
  'descuentos_promociones',
  'Descuentos / promociones',
  null,
  'semi_auto',
  '¿Qué descuento tengo? ¿Hay promociones?',
  ARRAY['descuento', 'promoción', 'promocion', 'oferta', 'bonificación', 'bonificacion', 'que descuento tengo', 'cuanto me hacen', 'hay promo', 'cyber', 'hot sale'],
  'Tus descuentos son:\n📦 *Por volumen*: [X]% (según tu categoría)\n💻 *Por compra web*: 2% adicional\n💰 *Por pago*:\n  • Contado (0-14 días): 25%\n  • 30 días: 20%\n  • 60 días: 10%\n  • 90 días: 5%\n\nEstoy consultando tu descuento por volumen específico...',
  'Tus descuentos: por volumen (el tuyo) + 2% por compra web + por pago (Contado 25% pagando de 0 a 14 días de la factura; baja según el plazo).',
  true,
  'customer_discount',
  75,
  18,
  8.04,
  'Los descuentos por pago son fijos. El de volumen varía por cliente (buscar en customers). El 2% por compra web es universal.'
),

-- ────────────────────────────────────────────────────────────
-- 6. ESTADO / DEMORA DEL PEDIDO  (5.4%)
-- ────────────────────────────────────────────────────────────
(
  'estado_demora_pedido',
  'Estado / demora del pedido',
  null,
  'semi_auto',
  '¿En qué estado está mi pedido? ¿Por qué se demora?',
  ARRAY['estado del pedido', 'demora', 'tarda', 'se demora', 'donde está mi pedido', 'donde esta mi pedido', 'seguimiento', 'tracking', 'no llega', 'cuanto falta', 'cuando me entregan'],
  'Estoy consultando el estado de tu pedido. Tu pedido [N° pedido] está en estado: [estado]. Fue programado para el [fecha]. La fecha de salida del centro de distribución es aproximada (puede variar 2-3 días).',
  E'Estimado Cliente:\nSu pedido ya fue programado para el día *----------*\nTenga en cuenta que la fecha en que saldrá su pedido de nuestro centro de distribución es aproximada y puede tener una diferencia de 2 o 3 días de lo informado.\nSaludos.\nDpto. de Ventas.',
  true,
  'order_status',
  74,
  12,
  5.36,
  'Consultar order_tracking. Si está "entregado" informar. Si hay demora real, derivar al vendedor.'
),

-- ────────────────────────────────────────────────────────────
-- 7. FACTURACIÓN / COMPROBANTE  (5.4%)
-- ────────────────────────────────────────────────────────────
(
  'facturacion_comprobante',
  'Facturación / comprobante',
  null,
  'full_auto',
  'No me llegó la factura / Necesito el comprobante',
  ARRAY['factura', 'comprobante', 'no me llegó la factura', 'no me llego', 'remito', 'facturación', 'facturacion', 'reenviar factura', 'nota de crédito', 'nota de credito', 'necesito factura'],
  'La factura se envía por mail el día que sale tu pedido (revisá la carpeta de spam). La mercadería viaja solo con remito.\n\nSi no te llegó, pasame tu CUIT o N° de pedido y la reenviamos. 📧',
  'La factura se envía por mail el día que sale (revisá spam). La mercadería viaja solo con remito. Si no te llegó, avisanos y la reenviamos.',
  false,
  null,
  70,
  12,
  5.36,
  'Respuesta estándar. Si piden reenvío, tomar CUIT y derivar a administración.'
),

-- ────────────────────────────────────────────────────────────
-- 8. PRECIOS / LISTA  (5.4%)
-- ────────────────────────────────────────────────────────────
(
  'precios_lista',
  'Precios / lista',
  'consultar_precios',
  'full_auto',
  '¿Me pasás la lista de precios?',
  ARRAY['lista de precios', 'cotizador', 'precios', 'cotización', 'cotizacion', 'precio', 'cuanto sale', 'cuánto sale', 'pasame la lista', 'lista actualizada', 'lista vigente', 'pagina web precios'],
  'Podés ver los precios ingresando a nuestra página web loekemeyer.com con tu CUIT — ahí ves los precios con tus descuentos aplicados.\n\n🔗 loekemeyer.com → "Pedidos Mayorista"\n\nComprar por la web incluye un 2% adicional de descuento.',
  E'Estimados clientes,\n\nCon el objetivo de mejorar su experiencia de compra, desarrollamos una nueva plataforma online para que puedan enviarnos sus pedidos de forma más ágil y sencilla.\n\nA través de Loekemeyer.com podrán gestionar su reposición con mayor facilidad, acceder a nuevos productos, consultar su historial de compras desde 2020 en adelante y repetir pedidos en un solo paso, sugerencias de compras por IA, entre otras funcionalidades.\n\nPara acceder, ingresen a Loekemeyer.com, hagan clic en "Pedidos Mayorista" e inicien sesión con su CUIT y contraseña detallada:\n\n*Tu Contraseña es ------- *\n\nQuedamos a disposición para cualquier consulta.\n\nSaludos cordiales,\nEquipo Loekemeyer',
  false,
  null,
  72,
  12,
  5.36,
  'Respuesta fija. Redirigir a la página web.'
),

(
  'precios_lista',
  'Precios / lista',
  'consulta_precio_articulo',
  'semi_auto',
  '¿Cuánto sale el artículo [código]?',
  ARRAY['cuanto sale', 'precio del', 'precio de', 'cuánto cuesta', 'cuanto cuesta', 'valor del', 'precio artículo', 'precio articulo'],
  'Estoy consultando el precio del artículo que me pedís. Los precios de la web son sin IVA. Al total se le aplica tu descuento por volumen + 2% por compra web + descuento por plazo de pago.',
  null,
  true,
  'product_price',
  68,
  0,
  0,
  'Buscar en products por código. Informar precio + IVA + descuentos aplicables.'
),

(
  'precios_lista',
  'Precios / lista',
  'aumento_precios',
  'full_auto',
  '¿Hubo aumento? ¿Sigue vigente la lista?',
  ARRAY['aumento', 'aumentó', 'subió', 'subio', 'sigue vigente', 'lista nueva', 'precios nuevos', 'actualizaron precios'],
  'La lista de precios vigente es la que está en la página web. Por el momento no tenemos aviso de aumento. Ingresá a loekemeyer.com para ver los precios actualizados.',
  null,
  false,
  null,
  65,
  0,
  0,
  'Respuesta genérica. Cuando haya aumento real, actualizar esta respuesta o marcarla inactiva temporalmente.'
),

-- ────────────────────────────────────────────────────────────
-- 9. STOCK / DISPONIBILIDAD  (4.0%)
-- ────────────────────────────────────────────────────────────
(
  'stock_disponibilidad',
  'Stock / disponibilidad',
  null,
  'semi_auto',
  '¿Tienen stock de [artículo]?',
  ARRAY['stock', 'disponibilidad', 'tienen', 'hay', 'disponible', 'queda', 'quedan', 'tienen stock', 'hay stock', 'agotado', 'sin stock'],
  'El stock actualizado lo podés ver en loekemeyer.com ingresando con tu CUIT.\n\nSi necesitás confirmar un artículo puntual, decime el código y lo consulto.',
  'El stock lo ves en la web (loekemeyer.com). Si necesitás confirmar un artículo puntual, lo consulto y te confirmo.',
  true,
  'product_stock',
  60,
  9,
  4.02,
  'Primero respuesta genérica con link. Si manda código, buscar en products.stock.'
),

-- ────────────────────────────────────────────────────────────
-- 10. PAGO / CBU / FORMAS DE PAGO  (3.6%)
-- ────────────────────────────────────────────────────────────
(
  'pago_cbu_formas',
  'Pago / CBU / formas de pago',
  null,
  'full_auto',
  '¿Cuáles son los datos para transferir / formas de pago?',
  ARRAY['pago', 'CBU', 'transferir', 'formas de pago', 'como pago', 'cómo pago', 'datos bancarios', 'cuenta bancaria', 'transferencia', 'mercadopago', 'efectivo', 'cheque', 'datos para pagar'],
  '🏦 *Datos para transferencia:*\nLOEKEMEYER HNOS. S.R.L.\nBanco Credicoop\nCC 027-23874/5\nCBU: 1910027855002702387450\n\n📲 El comprobante de pago envialo al sector de Cobranzas:\nWhatsApp 11 6557-4113\n\n💰 *Descuentos por pago:*\n• Contado (0-14 días): 25%\n• 30 días: 20%\n• 60 días: 10%\n• 90 días: 5%',
  'Los datos para realizar el pago: LOEKEMEYER HNOS. S.R.L. — Banco Credicoop, CC 027-23874/5, CBU 1910027855002702387450. El comprobante va al sector de Cobranzas (WhatsApp 11 6557-4113).',
  false,
  null,
  55,
  8,
  3.57,
  'Respuesta 100% fija. Datos bancarios y contacto de cobranzas no cambian frecuentemente.'
),

-- ────────────────────────────────────────────────────────────
-- 11. DEVOLUCIÓN / RECLAMO / FALLADO  (3.1%)
-- ────────────────────────────────────────────────────────────
(
  'devolucion_reclamo',
  'Devolución / reclamo / fallado',
  null,
  'needs_human',
  'Tengo un problema con un producto / Necesito devolver',
  ARRAY['devolución', 'devolucion', 'reclamo', 'fallado', 'defecto', 'devolver', 'cambio', 'roto', 'dañado', 'danado', 'problema con', 'mal estado', 'no funciona', 'falla', 'garantía', 'garantia'],
  'Lamento el inconveniente. Voy a derivar tu caso al equipo de ventas para que lo resuelvan.\n\nPor favor indicame:\n📦 N° de pedido o factura\n🔢 Código del artículo\n📸 Foto del problema (si aplica)\n\nUn vendedor se va a comunicar con vos a la brevedad.',
  null,
  false,
  null,
  50,
  7,
  3.13,
  'SIEMPRE derivar a humano. El bot solo recolecta datos iniciales (pedido, artículo, foto).'
),

-- ────────────────────────────────────────────────────────────
-- 12. URGENCIA DE RETIRO  (1.8%)
-- ────────────────────────────────────────────────────────────
(
  'urgencia_retiro',
  'Urgencia de retiro',
  null,
  'needs_human',
  'Necesito retirar urgente / ¿Puedo pasar hoy?',
  ARRAY['urgente retiro', 'urgencia', 'puedo pasar hoy', 'necesito hoy', 'retiro urgente', 'para hoy', 'lo antes posible retiro', 'ya mismo'],
  'Entiendo la urgencia. Voy a consultar con el depósito si es posible programar tu retiro para hoy.\n\n📍 Recordá: Virgilio 2788, Villa Devoto\n🕐 Horario: 10 a 12 hs y 13 a 16 hs\n\nTe confirmo a la brevedad.',
  null,
  true,
  'order_status',
  45,
  4,
  1.79,
  'Derivar al vendedor. El bot no puede confirmar disponibilidad de retiro anticipado.'
),

-- ────────────────────────────────────────────────────────────
-- 13. URGENCIA EN ENTREGA  (1.3%)
-- ────────────────────────────────────────────────────────────
(
  'urgencia_entrega',
  'Urgencia en entrega',
  null,
  'needs_human',
  'Necesito que me llegue urgente / ¿Pueden adelantar la entrega?',
  ARRAY['urgente entrega', 'necesito ya', 'cuanto antes', 'adelantar entrega', 'más rápido', 'mas rapido', 'apurar', 'urgente envío', 'urgente envio', 'necesito antes'],
  'Entiendo la urgencia. Voy a consultar con logística si es posible adelantar tu entrega. Te confirmo a la brevedad.',
  null,
  true,
  'order_status',
  44,
  3,
  1.34,
  'Derivar siempre. El bot no puede alterar programación de transporte.'
),

-- ────────────────────────────────────────────────────────────
-- 14. CATÁLOGO / NOVEDADES  (1.3%)
-- ────────────────────────────────────────────────────────────
(
  'catalogo_novedades',
  'Catálogo / novedades',
  null,
  'full_auto',
  '¿Me pasás el catálogo? ¿Qué novedades tienen?',
  ARRAY['catálogo', 'catalogo', 'novedades', 'productos nuevos', 'artículos nuevos', 'articulos nuevos', 'que hay nuevo', 'lanzamientos', 'nuevos ingresos'],
  'Podés encontrar el catálogo en loekemeyer.com (se descarga desde la página, en la sección de abajo).\n\n📘 También te lo enviamos por acá si preferís.\n\n¿Querés que te lo mande?',
  'Podés encontrar el catálogo dentro de la web en loekemeyer.com (se descarga desde la página, más abajo).',
  false,
  null,
  40,
  3,
  1.34,
  'Respuesta fija + adjuntar PDF del catálogo si es posible.'
),

-- ────────────────────────────────────────────────────────────
-- 15. ENVÍO DE COMPROBANTE DE PAGO  (0.4%)
-- ────────────────────────────────────────────────────────────
(
  'envio_comprobante_pago',
  'Envío de comprobante de pago',
  null,
  'full_auto',
  '¿A dónde mando el comprobante de pago?',
  ARRAY['comprobante de pago', 'a dónde mando', 'a donde mando', 'enviar comprobante', 'mando transferencia', 'comprobante transferencia', 'ya transferí', 'ya transferi', 'ya pagué', 'ya pague'],
  '📲 Enviá el comprobante de pago al sector de *Cobranzas*:\nWhatsApp: *11 6557-4113*\n\nEllos se encargan de registrar tu pago.',
  'Enviá el comprobante de pago al sector de Cobranzas: WhatsApp 11 6557-4113.',
  false,
  null,
  35,
  1,
  0.45,
  'Respuesta 100% fija. Redireccionar siempre a Cobranzas.'
),

-- ────────────────────────────────────────────────────────────
-- 16. MÍNIMO DE COMPRA / POR UNIDAD  (0.4%)
-- ────────────────────────────────────────────────────────────
(
  'minimo_compra',
  'Mínimo de compra / por unidad',
  null,
  'full_auto',
  '¿Cuál es el mínimo de compra? ¿Venden por unidad?',
  ARRAY['mínimo', 'minimo', 'mínimo de compra', 'minimo de compra', 'por unidad', 'unidad', 'cuanto es el mínimo', 'compra mínima', 'compra minima', 'venden suelto', 'caja cerrada'],
  '📦 *Monto mínimo de compra:*\n• Para entrega: $500.000\n• Para retiro: $300.000\n\nVendemos solo en *caja cerrada* (6 o 12 unidades según el artículo). No vendemos por unidad suelta.',
  'El monto mínimo de compra es $500.000. Vendemos solo en caja cerrada (6 o 12 unidades).',
  false,
  null,
  30,
  1,
  0.45,
  'Respuesta fija. Montos mínimos pueden cambiar — actualizar cuando corresponda.'
);


-- ============================================================
-- FUNCIÓN HELPER: buscar FAQ por keywords
-- Útil para que el bot encuentre la respuesta correcta
-- ============================================================

create or replace function wa_faq_match(p_text text)
returns table (
  faq_id       bigint,
  category     text,
  subcategory  text,
  automation_level text,
  bot_response text,
  requires_db_lookup boolean,
  db_lookup_type text,
  match_score  int
) as $$
begin
  return query
    select
      f.id as faq_id,
      f.category,
      f.subcategory,
      f.automation_level,
      f.bot_response,
      f.requires_db_lookup,
      f.db_lookup_type,
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
