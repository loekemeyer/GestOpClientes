-- ============================================================
-- 033_wa_question_variants.sql
-- Mapeo de variaciones de preguntas para clustering automático
-- Agrupa múltiples formas de hacer la misma pregunta
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- TABLA: wa_question_group
-- Grupos de preguntas relacionadas (clustering)
-- ────────────────────────────────────────────────────────────

create table if not exists wa_question_group (
  id                  bigint generated always as identity primary key,
  faq_id              bigint not null references wa_faq(id) on delete cascade,
  group_name          text not null,                  -- nombre legible del grupo (ej: 'estado_pedido')
  group_label         text not null,                  -- etiqueta para el usuario (ej: 'Estado / Seguimiento del pedido')
  primary_question    text not null,                  -- pregunta principal/canónica del grupo
  category_intent     text not null,                  -- intent para NLP (ej: 'order_status', 'new_order')
  description         text,                           -- descripción interna del tipo de pregunta
  is_active           boolean not null default true,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index idx_wa_question_group_faq on wa_question_group(faq_id);
create index idx_wa_question_group_intent on wa_question_group(category_intent);
create index idx_wa_question_group_active on wa_question_group(is_active);

-- Trigger updated_at
create or replace function trg_wa_question_group_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger wa_question_group_updated
  before update on wa_question_group
  for each row execute function trg_wa_question_group_updated();

-- ────────────────────────────────────────────────────────────
-- TABLA: wa_question_variant
-- Variaciones de la misma pregunta (sinónimos/paráfrasis)
-- ────────────────────────────────────────────────────────────

create table if not exists wa_question_variant (
  id                  bigint generated always as identity primary key,
  group_id            bigint not null references wa_question_group(id) on delete cascade,
  variant_text        text not null unique,            -- la variación de la pregunta exacta
  normalized_text     text not null,                   -- versión normalizada (lowercase, sin acentos)
  source              text,                            -- origen: 'client_chat', 'qa_research', 'manual', 'ml_extracted'
  confidence_score    numeric(3,2) default 0.90,       -- qué tan seguro estamos de la variación (0-1)
  is_active           boolean not null default true,
  frequency_count     int default 0,                   -- cuántas veces se detectó en chats
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index idx_wa_question_variant_group on wa_question_variant(group_id);
create index idx_wa_question_variant_active on wa_question_variant(is_active);
create index idx_wa_question_variant_normalized on wa_question_variant(normalized_text);

-- Trigger updated_at
create or replace function trg_wa_question_variant_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger wa_question_variant_updated
  before update on wa_question_variant
  for each row execute function trg_wa_question_variant_updated();

-- ────────────────────────────────────────────────────────────
-- TABLA: wa_intent_response
-- Respuestas predefinidas por intent (para deduplicar)
-- ────────────────────────────────────────────────────────────

create table if not exists wa_intent_response (
  id                  bigint generated always as identity primary key,
  intent              text not null unique,            -- ej: 'order_status', 'new_order'
  intent_label        text not null,                   -- ej: 'Consultar estado del pedido'
  standard_response   text not null,                   -- respuesta estándar para este intent
  follow_up_options   text[] default '{}',             -- opciones de seguimiento (JSON)
  requires_context    boolean default false,           -- necesita contexto del cliente (customer_id)
  db_lookups          text[] default '{}',             -- lookups necesarios: ['order_status', 'customer_discount']
  automation_level    text default 'semi_auto',        -- auto/semi_auto/inteligencia/humano
  is_active           boolean not null default true,
  notes               text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index idx_wa_intent_response_active on wa_intent_response(is_active);
create index idx_wa_intent_response_automation on wa_intent_response(automation_level);

-- Trigger updated_at
create or replace function trg_wa_intent_response_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger wa_intent_response_updated
  before update on wa_intent_response
  for each row execute function trg_wa_intent_response_updated();

-- ────────────────────────────────────────────────────────────
-- SEED DATA: Agrupaciones de preguntas
-- ────────────────────────────────────────────────────────────

insert into wa_question_group (
  faq_id, group_name, group_label, primary_question,
  category_intent, description
) values

-- Cluster 1: ESTADO DEL PEDIDO (agrupa preguntas sobre estado/seguimiento/cuándo llega)
(1, 'order_status_cluster', 'Estado y seguimiento del pedido',
 '¿En qué estado está mi pedido? ¿Cuándo llega?',
 'order_status', 'Preguntas sobre el estado actual, seguimiento y fecha estimada de entrega'),

-- Cluster 2: HACER NUEVO PEDIDO
(2, 'new_order_cluster', 'Hacer nuevo pedido',
 'Quiero hacer un pedido / pasar un pedido',
 'new_order', 'Preguntas para iniciar un nuevo pedido o pasar datos de productos'),

-- Cluster 3: RETIRO EN DEPÓSITO
(3, 'pickup_cluster', 'Retiro en depósito',
 '¿Dónde y cuándo retiro mi pedido?',
 'pickup_location', 'Preguntas sobre dónde retirar y horarios de atención'),

-- Cluster 4: REGISTRO Y ACCESO WEB
(5, 'customer_onboarding_cluster', 'Alta de cliente y acceso web',
 'Quiero darme de alta / No puedo acceder a la web',
 'customer_registration', 'Preguntas de nuevos clientes y problemas de acceso'),

-- Cluster 5: DESCUENTOS Y PROMOCIONES
(7, 'discounts_cluster', 'Descuentos y condiciones comerciales',
 '¿Qué descuentos tengo? ¿Hay promociones?',
 'customer_discount', 'Consultas sobre bonificaciones, descuentos por volumen/pago/web'),

-- Cluster 6: PRECIOS Y LISTA
(10, 'pricing_cluster', 'Consultas de precios y listas',
 '¿Cuánto cuesta? ¿Me pasás la lista de precios?',
 'pricing_inquiry', 'Preguntas sobre precios, cotizaciones, lista actualizada'),

-- Cluster 7: STOCK Y DISPONIBILIDAD
(13, 'inventory_cluster', 'Stock y disponibilidad de productos',
 '¿Tienen stock de X?',
 'inventory_check', 'Consultas sobre disponibilidad de productos específicos'),

-- Cluster 8: FORMAS DE PAGO Y CBU
(14, 'payment_methods_cluster', 'Formas de pago y datos bancarios',
 '¿Cuáles son los datos para pagar? ¿Qué formas de pago aceptan?',
 'payment_info', 'Preguntas sobre métodos de pago, CBU, transferencias'),

-- Cluster 9: PROBLEMAS Y DEVOLUCIONES
(15, 'complaint_cluster', 'Reclamos, devoluciones y problemas',
 'Tengo un problema con un producto / Necesito devolver',
 'complaint', 'Reportes de defectos, faltantes, daños, devoluciones'),

-- Cluster 10: URGENCIAS
(16, 'urgency_cluster', 'Urgencias de retiro y entrega',
 '¿Puedo pasar hoy? ¿Necesito urgente?',
 'urgency_request', 'Solicitudes urgentes de retiro o entrega anticipada'),

-- Cluster 11: CONTACTO CON VENDEDOR
(23, 'seller_contact_cluster', 'Contacto con vendedor asignado',
 'Quiero hablar con mi vendedor',
 'seller_contact', 'Solicitudes de comunicación con vendedor asignado'),

-- Cluster 12: CONSULTAS DE PRODUCTOS
(24, 'product_inquiry_cluster', 'Consultas sobre productos específicos',
 '¿Qué modelos tienen? ¿Trabajan con X marca?',
 'product_search', 'Preguntas sobre modelos, marcas, categorías de productos'),

-- Cluster 13: FACTURAS Y COMPROBANTES
(9, 'billing_cluster', 'Facturas, remitos y comprobantes',
 'No me llegó la factura / Necesito el comprobante',
 'billing_documents', 'Solicitudes de facturas, remitos, comprobantes de pago');

-- ────────────────────────────────────────────────────────────
-- SEED DATA: Variaciones de preguntas por cluster
-- ────────────────────────────────────────────────────────────

insert into wa_question_variant (
  group_id, variant_text, normalized_text, source, confidence_score, frequency_count
) values

-- CLUSTER 1: Order Status (13 variaciones)
(1, '¿Cuándo llega mi pedido?', 'cuando llega mi pedido', 'client_chat', 0.99, 45),
(1, '¿En qué estado está mi pedido?', 'en que estado esta mi pedido', 'client_chat', 0.98, 38),
(1, '¿Alguna novedad de mi entrega?', 'alguna novedad de mi entrega', 'client_chat', 0.95, 12),
(1, '¿Cuándo sale mi pedido?', 'cuando sale mi pedido', 'client_chat', 0.96, 18),
(1, '¿Ya despacharon mi pedido?', 'ya despacharon mi pedido', 'client_chat', 0.94, 8),
(1, '¿Cuándo me llega la mercadería?', 'cuando me llega la mercaderia', 'client_chat', 0.95, 15),
(1, '¿Dónde está mi pedido?', 'donde esta mi pedido', 'client_chat', 0.97, 22),
(1, '¿Hay novedades de mi envío?', 'hay novedades de mi envio', 'client_chat', 0.93, 7),
(1, '¿Qué fecha de entrega tengo?', 'que fecha de entrega tengo', 'client_chat', 0.92, 5),
(1, '¿Cuánto falta para que llegue?', 'cuanto falta para que llegue', 'client_chat', 0.91, 4),
(1, '¿Cuándo pasó a despacho?', 'cuando paso a despacho', 'client_chat', 0.90, 3),
(1, '¿Ya salió mi pedido?', 'ya salio mi pedido', 'client_chat', 0.94, 9),
(1, '¿Mi pedido está programado?', 'mi pedido esta programado', 'client_chat', 0.92, 6),

-- CLUSTER 2: New Order (11 variaciones)
(2, 'Quiero hacer un pedido', 'quiero hacer un pedido', 'client_chat', 0.99, 52),
(2, 'Necesito pasar un pedido', 'necesito pasar un pedido', 'client_chat', 0.98, 28),
(2, 'Quiero pedir', 'quiero pedir', 'client_chat', 0.97, 31),
(2, '¿Cómo hago un pedido?', 'como hago un pedido', 'client_chat', 0.96, 14),
(2, 'Quiero armar un pedido', 'quiero armar un pedido', 'client_chat', 0.95, 11),
(2, 'Pasame cómo hago un pedido', 'pasame como hago un pedido', 'client_chat', 0.93, 7),
(2, 'Tengo productos para pedir', 'tengo productos para pedir', 'client_chat', 0.92, 5),
(2, 'Envío mi pedido', 'envio mi pedido', 'client_chat', 0.91, 4),
(2, 'Necesito hacer una orden', 'necesito hacer una orden', 'client_chat', 0.90, 3),
(2, '¿Me ayudas a hacer un pedido?', 'me ayudas a hacer un pedido', 'client_chat', 0.89, 2),
(2, 'Tengo cantidades para consultar', 'tengo cantidades para consultar', 'client_chat', 0.88, 2),

-- CLUSTER 3: Pickup Location (8 variaciones)
(3, '¿Dónde retiro mi pedido?', 'donde retiro mi pedido', 'client_chat', 0.99, 35),
(3, '¿Cuál es la dirección del depósito?', 'cual es la direccion del deposito', 'client_chat', 0.97, 22),
(3, '¿Horarios de retiro?', 'horarios de retiro', 'client_chat', 0.96, 18),
(3, '¿Dónde queda el depósito?', 'donde queda el deposito', 'client_chat', 0.95, 15),
(3, '¿Cuándo puedo pasar a buscar?', 'cuando puedo pasar a buscar', 'client_chat', 0.94, 12),
(3, '¿Direccion para retirar?', 'direccion para retirar', 'client_chat', 0.92, 8),
(3, '¿Para cuándo puedo programar el retiro?', 'para cuando puedo programar el retiro', 'client_chat', 0.91, 6),
(3, 'Información del lugar de retiro', 'informacion del lugar de retiro', 'client_chat', 0.90, 4),

-- CLUSTER 4: Customer Onboarding (9 variaciones)
(4, 'Quiero darme de alta', 'quiero darme de alta', 'client_chat', 0.99, 28),
(4, 'Soy cliente nuevo', 'soy cliente nuevo', 'client_chat', 0.98, 19),
(4, '¿Cómo me registro?', 'como me registro', 'client_chat', 0.97, 14),
(4, 'No puedo entrar a la web', 'no puedo entrar a la web', 'client_chat', 0.96, 11),
(4, 'Olvide mi contraseña', 'olvide mi contrasena', 'client_chat', 0.95, 9),
(4, '¿Cuál es mi contraseña?', 'cual es mi contrasena', 'client_chat', 0.94, 7),
(4, 'No me deja acceder', 'no me deja acceder', 'client_chat', 0.93, 6),
(4, 'Necesito resetear mi clave', 'necesito resetear mi clave', 'client_chat', 0.92, 4),
(4, '¿Cómo entro a loekemeyer.com?', 'como entro a loekemeyer.com', 'client_chat', 0.91, 3),

-- CLUSTER 5: Discounts (10 variaciones)
(5, '¿Qué descuento tengo?', 'que descuento tengo', 'client_chat', 0.99, 42),
(5, '¿Hay promociones?', 'hay promociones', 'client_chat', 0.97, 28),
(5, '¿Cuánto me hacen de descuento?', 'cuanto me hacen de descuento', 'client_chat', 0.96, 18),
(5, '¿Qué bonificación tengo?', 'que bonificacion tengo', 'client_chat', 0.95, 12),
(5, '¿Hay descuentos por volumen?', 'hay descuentos por volumen', 'client_chat', 0.94, 10),
(5, '¿Qué descuento por pago contado?', 'que descuento por pago contado', 'client_chat', 0.93, 8),
(5, '¿Hay cyber o hot sale?', 'hay cyber o hot sale', 'client_chat', 0.92, 5),
(5, '¿Cuál es mi descuento?', 'cual es mi descuento', 'client_chat', 0.91, 7),
(5, '¿Hay ofertas?', 'hay ofertas', 'client_chat', 0.90, 4),
(5, '¿Descuentos por cliente frecuente?', 'descuentos por cliente frecuente', 'client_chat', 0.88, 2),

-- CLUSTER 6: Pricing (12 variaciones)
(6, '¿Me pasás la lista de precios?', 'me pasas la lista de precios', 'client_chat', 0.99, 48),
(6, '¿Cuánto cuesta esto?', 'cuanto cuesta esto', 'client_chat', 0.98, 35),
(6, '¿Cuánto vale?', 'cuanto vale', 'client_chat', 0.97, 22),
(6, '¿Qué precio tienen?', 'que precio tienen', 'client_chat', 0.96, 18),
(6, '¿Precio de X producto?', 'precio de x producto', 'client_chat', 0.95, 14),
(6, 'Necesito presupuesto', 'necesito presupuesto', 'client_chat', 0.94, 12),
(6, '¿Cotización de...?', 'cotizacion de', 'client_chat', 0.93, 9),
(6, '¿Sigue vigente la lista?', 'sigue vigente la lista', 'client_chat', 0.92, 7),
(6, '¿Hubo aumento?', 'hubo aumento', 'client_chat', 0.91, 6),
(6, '¿La lista es actual?', 'la lista es actual', 'client_chat', 0.90, 4),
(6, 'Mandame precios', 'mandame precios', 'client_chat', 0.89, 3),
(6, '¿Precio actual de...?', 'precio actual de', 'client_chat', 0.88, 2),

-- CLUSTER 7: Inventory (8 variaciones)
(7, '¿Tienen stock de X?', 'tienen stock de x', 'client_chat', 0.99, 32),
(7, '¿Hay disponible?', 'hay disponible', 'client_chat', 0.97, 19),
(7, '¿Quedan unidades?', 'quedan unidades', 'client_chat', 0.96, 14),
(7, '¿Se agotó?', 'se agoto', 'client_chat', 0.95, 9),
(7, '¿Está en stock?', 'esta en stock', 'client_chat', 0.94, 11),
(7, '¿Disponibilidad de...?', 'disponibilidad de', 'client_chat', 0.93, 7),
(7, '¿Sin stock?', 'sin stock', 'client_chat', 0.92, 5),
(7, '¿Cuándo hay stock?', 'cuando hay stock', 'client_chat', 0.91, 3),

-- CLUSTER 8: Payment Methods (10 variaciones)
(8, '¿Cuáles son los datos para transferir?', 'cuales son los datos para transferir', 'client_chat', 0.99, 38),
(8, '¿CBU de Loekemeyer?', 'cbu de loekemeyer', 'client_chat', 0.98, 22),
(8, '¿Formas de pago que aceptan?', 'formas de pago que aceptan', 'client_chat', 0.97, 18),
(8, '¿Cómo pago?', 'como pago', 'client_chat', 0.96, 15),
(8, '¿Aceptan tarjeta?', 'aceptan tarjeta', 'client_chat', 0.95, 11),
(8, '¿Aceptan Mercado Pago?', 'aceptan mercado pago', 'client_chat', 0.94, 9),
(8, '¿Datos bancarios?', 'datos bancarios', 'client_chat', 0.93, 7),
(8, '¿Cuotas sin interés?', 'cuotas sin interes', 'client_chat', 0.92, 6),
(8, '¿Financiación?', 'financiacion', 'client_chat', 0.91, 8),
(8, '¿Cheques?', 'cheques', 'client_chat', 0.90, 4),

-- CLUSTER 9: Complaints (9 variaciones)
(9, 'Tengo un problema con un producto', 'tengo un problema con un producto', 'client_chat', 0.99, 28),
(9, 'Necesito devolver', 'necesito devolver', 'client_chat', 0.98, 18),
(9, 'Llegó defectuoso', 'llego defectuoso', 'client_chat', 0.97, 14),
(9, 'Reclamo', 'reclamo', 'client_chat', 0.96, 11),
(9, '¿Hay faltante en mi pedido?', 'hay faltante en mi pedido', 'client_chat', 0.95, 9),
(9, 'Está roto', 'esta roto', 'client_chat', 0.94, 7),
(9, 'Dañado', 'danado', 'client_chat', 0.93, 5),
(9, 'No funciona', 'no funciona', 'client_chat', 0.92, 4),
(9, 'Mal estado', 'mal estado', 'client_chat', 0.91, 3),

-- CLUSTER 10: Urgency (7 variaciones)
(10, '¿Puedo pasar hoy?', 'puedo pasar hoy', 'client_chat', 0.99, 18),
(10, 'Necesito urgente', 'necesito urgente', 'client_chat', 0.98, 14),
(10, '¿Retiro urgente?', 'retiro urgente', 'client_chat', 0.97, 11),
(10, '¿Entrega rápida?', 'entrega rapida', 'client_chat', 0.96, 9),
(10, '¿Para hoy?', 'para hoy', 'client_chat', 0.95, 7),
(10, 'Lo antes posible', 'lo antes posible', 'client_chat', 0.94, 5),
(10, '¿Pueden adelantar?', 'pueden adelantar', 'client_chat', 0.93, 4),

-- CLUSTER 11: Seller Contact (6 variaciones)
(11, 'Quiero hablar con mi vendedor', 'quiero hablar con mi vendedor', 'client_chat', 0.99, 22),
(11, '¿Quién es mi vendedor?', 'quien es mi vendedor', 'client_chat', 0.98, 15),
(11, 'Pasame con mi asesor', 'pasame con mi asesor', 'client_chat', 0.97, 10),
(11, '¿Contacto con representante?', 'contacto con representante', 'client_chat', 0.96, 7),
(11, 'Necesito hablar con ventas', 'necesito hablar con ventas', 'client_chat', 0.95, 6),
(11, '¿Datos del vendedor?', 'datos del vendedor', 'client_chat', 0.94, 4),

-- CLUSTER 12: Product Inquiry (10 variaciones)
(12, '¿Qué modelos tienen?', 'que modelos tienen', 'client_chat', 0.99, 32),
(12, '¿Trabajan con X marca?', 'trabajan con x marca', 'client_chat', 0.98, 24),
(12, '¿Qué opciones hay de...?', 'que opciones hay de', 'client_chat', 0.97, 18),
(12, '¿Tienen la línea X?', 'tienen la linea x', 'client_chat', 0.96, 14),
(12, '¿Qué tiene en categoría X?', 'que tiene en categoria x', 'client_chat', 0.95, 11),
(12, '¿Cuántas variantes hay?', 'cuantas variantes hay', 'client_chat', 0.94, 8),
(12, '¿Me muestran productos de X?', 'me muestran productos de x', 'client_chat', 0.93, 6),
(12, '¿Colores disponibles?', 'colores disponibles', 'client_chat', 0.92, 5),
(12, '¿Medidas de...?', 'medidas de', 'client_chat', 0.91, 4),
(12, 'Catálogo de X', 'catalogo de x', 'client_chat', 0.90, 3),

-- CLUSTER 13: Billing (8 variaciones)
(13, 'No me llegó la factura', 'no me llego la factura', 'client_chat', 0.99, 26),
(13, 'Necesito el comprobante', 'necesito el comprobante', 'client_chat', 0.98, 18),
(13, '¿Dónde está mi factura?', 'donde esta mi factura', 'client_chat', 0.97, 14),
(13, '¿Me reenviás la factura?', 'me reenvias la factura', 'client_chat', 0.96, 11),
(13, 'Necesito remito', 'necesito remito', 'client_chat', 0.95, 8),
(13, '¿Nota de crédito?', 'nota de credito', 'client_chat', 0.94, 6),
(13, 'Factura electronica', 'factura electronica', 'client_chat', 0.93, 4),
(13, '¿Comprobante de pago?', 'comprobante de pago', 'client_chat', 0.92, 3);

-- ────────────────────────────────────────────────────────────
-- SEED DATA: Intent Responses (deduplicadas)
-- ────────────────────────────────────────────────────────────

insert into wa_intent_response (
  intent, intent_label, standard_response, requires_context,
  db_lookups, automation_level
) values

('order_status', 'Estado del pedido',
 'Tu pedido está programado para el [fecha]. La fecha de salida es aproximada y puede variar 2-3 días.',
 true, ARRAY['order_status', 'order_tracking'], 'semi_auto'),

('new_order', 'Nuevo pedido',
 'Podés hacer tu pedido por: 1️⃣ Web (loekemeyer.com) 2️⃣ Aquí pasándome códigos y cantidades',
 true, ARRAY['product_match', 'order_create'], 'semi_auto'),

('pickup_location', 'Retiro en depósito',
 '📍 Virgilio 2788, Villa Devoto | 🕐 L-V 10-12 y 13-16 hs | Si no retiras en fecha, se desarma.',
 false, ARRAY[]::text[], 'auto'),

('customer_registration', 'Alta de cliente',
 'Para registrarte necesitamos: razón social, CUIT, teléfono, dirección, tipo de comercio, expreso...',
 false, ARRAY['customer_create', 'prospect_leads'], 'semi_auto'),

('customer_discount', 'Descuentos',
 'Tus descuentos: por volumen [X]%, 2% web, Contado 25%, 30d 20%, 60d 10%, 90d 5%',
 true, ARRAY['customer_discount'], 'semi_auto'),

('pricing_inquiry', 'Consulta de precios',
 'Los precios están en loekemeyer.com (con tu descuento). ¿Qué artículo necesitás?',
 true, ARRAY['product_price'], 'semi_auto'),

('inventory_check', 'Stock disponible',
 'El stock actualizado está en loekemeyer.com. ¿Qué código específico necesitás?',
 true, ARRAY['product_stock'], 'semi_auto'),

('payment_info', 'Formas de pago',
 'CBU: 1910027855002702387450 | Cobranzas WhatsApp: 11 6557-4113 | Descuentos por plazo de pago.',
 false, ARRAY[]::text[], 'auto'),

('complaint', 'Reclamo / Devolución',
 'Lamento el inconveniente. Voy a derivar al equipo. Indicame: N° pedido, código artículo, foto.',
 true, ARRAY['order_detail'], 'humano'),

('urgency_request', 'Urgencia',
 'Entiendo la urgencia. Voy a consultar con depósito/logística. Te confirmo a la brevedad.',
 true, ARRAY['order_status'], 'humano'),

('seller_contact', 'Contacto vendedor',
 'Tu vendedor es [nombre]. Ya le avisé. Te contacta a la brevedad.',
 true, ARRAY['seller_contact'], 'semi_auto'),

('product_search', 'Búsqueda de productos',
 'Tenemos estas opciones: [lista de productos]. ¿Querés ver más o agregar algo?',
 true, ARRAY['product_search', 'product_match'], 'semi_auto'),

('billing_documents', 'Facturas y comprobantes',
 'La factura se envía por mail el día que sale el pedido (revisá spam). ¿Necesitás reenvío?',
 true, ARRAY['invoice_resend'], 'auto');

-- ────────────────────────────────────────────────────────────
-- FUNCIÓN HELPER: Encontrar grupo de pregunta por variación
-- ────────────────────────────────────────────────────────────

create or replace function wa_find_question_group(p_question_text text)
returns table (
  group_id            bigint,
  group_name          text,
  intent              text,
  faq_id              bigint,
  variant_text        text,
  confidence_score    numeric,
  response            text
) as $$
declare
  v_normalized text;
begin
  v_normalized := lower(p_question_text);

  return query
    select
      qg.id as group_id,
      qg.group_name,
      qg.category_intent as intent,
      qg.faq_id,
      qv.variant_text,
      qv.confidence_score,
      ir.standard_response as response
    from wa_question_variant qv
    join wa_question_group qg on qv.group_id = qg.id
    join wa_intent_response ir on qg.category_intent = ir.intent
    where qv.is_active = true and qg.is_active = true and ir.is_active = true
    and (
      lower(qv.variant_text) = v_normalized
      or lower(qv.normalized_text) % lower(p_question_text)  -- fuzzy matching
    )
    order by
      case when lower(qv.variant_text) = v_normalized then 0 else 1 end,
      qv.confidence_score desc,
      qv.frequency_count desc
    limit 1;
end;
$$ language plpgsql stable security definer;

comment on function wa_find_question_group(text) is
  'Busca un grupo de pregunta por variación. Devuelve el grupo + intent + respuesta estándar.';

-- ────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────

alter table wa_question_group enable row level security;
alter table wa_question_variant enable row level security;
alter table wa_intent_response enable row level security;

-- Políticas de lectura para anon (el bot)
create policy "anon_read" on wa_question_group for select using (is_active = true);
create policy "anon_read" on wa_question_variant for select using (is_active = true);
create policy "anon_read" on wa_intent_response for select using (is_active = true);

-- Política service_role completa
create policy "service_role_all" on wa_question_group for all using (auth.role() = 'service_role');
create policy "service_role_all" on wa_question_variant for all using (auth.role() = 'service_role');
create policy "service_role_all" on wa_intent_response for all using (auth.role() = 'service_role');
