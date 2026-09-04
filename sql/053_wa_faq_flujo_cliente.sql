-- 053_wa_faq_flujo_cliente.sql
-- Flujo cara-al-cliente (acordado 2026-09-04):
--   • Saludo sin request → FAQ fija SEMIAUTO. Cliente: saluda por nombre.
--     No-cliente: pide CUIT para verificar (mismo copy que handleRegistration).
--   • Datos de pago (alias/CBU) → FAQ SEMIAUTO variable. Los valores salen de
--     app_settings.wa_descuentos_config (pago.alias / pago.cbu), editables desde
--     el Panel; el texto se edita en wa_faq. Nunca hard-coded.
-- Idempotente (guardas WHERE NOT EXISTS por subcategory / token).

-- ── FAQ saludo ────────────────────────────────────────────────────────────
insert into public.wa_faq
  (category, category_label, subcategory, automation_level, sample_question, keywords,
   bot_response, institutional_response, requires_db_lookup, db_lookup_type,
   priority, is_active, requires_product_match, notes)
select
  'saludo', 'Saludo', 'saludo_inicial', 'semi_auto', 'Hola',
  array['hola','holis','ola','buenas','buen dia','buenos dias','buenas tardes','buenas noches','hey','buenas!'],
  '¡Hola {{nombre_cliente}}! 👋 ¿En qué te puedo ayudar?',
  '¡Hola! 👋 No te tengo registrado como cliente. Decime si querés que te registre —así podés ver precios y hacer pedidos— o si tenés alguna consulta en la que te pueda ayudar.',
  false, null, 100, true, false,
  'Saludo sin request. Cliente → saluda por nombre. No-cliente → pide CUIT (mismo copy que handleRegistration).'
where not exists (select 1 from public.wa_faq where subcategory = 'saludo_inicial');

-- ── FAQ datos de pago (INACTIVA hasta deploy de faq.ts con lookup payment_data) ──
insert into public.wa_faq
  (category, category_label, subcategory, automation_level, sample_question, keywords,
   bot_response, institutional_response, requires_db_lookup, db_lookup_type,
   priority, is_active, requires_product_match, notes)
select
  'pago', 'Datos de pago', 'datos_transferencia', 'semi_auto', 'Me pasás el CBU para transferir?',
  array['cbu','alias','transferencia','transferir','deposito','depositar','datos para pagar','datos de pago','datos bancarios','como pago','donde pago','donde deposito'],
  '{{nombre_cliente}}, estos son los datos para transferir:' || chr(10) || chr(10) || '*Alias:* {{alias}}' || chr(10) || '*CBU:* {{cbu}}',
  'Estos son los datos para transferir:' || chr(10) || chr(10) || '*Alias:* {{alias}}' || chr(10) || '*CBU:* {{cbu}}',
  true, 'payment_data', 90, false, false,
  'SEMIAUTO. alias/CBU salen de app_settings.wa_descuentos_config (pago.alias/pago.cbu). INACTIVA hasta deploy de faq.ts (lookup payment_data). Activar con is_active=true post-deploy.'
where not exists (select 1 from public.wa_faq where subcategory = 'datos_transferencia');

-- ── Tokens para el editor del front (pestaña Preguntas frecuentes) ──────────
insert into public.wa_faq_lookup_tokens (db_lookup_type, token, label, descripcion, is_block, ejemplo, sort_order)
select 'payment_data', '{{alias}}', 'Alias', 'Alias para transferencias (config: wa_descuentos_config.pago.alias)', false, 'loeke.srl', 10
where not exists (select 1 from public.wa_faq_lookup_tokens where token = '{{alias}}');

insert into public.wa_faq_lookup_tokens (db_lookup_type, token, label, descripcion, is_block, ejemplo, sort_order)
select 'payment_data', '{{cbu}}', 'CBU', 'CBU para transferencias (config: wa_descuentos_config.pago.cbu)', false, '1910027855002702387450', 11
where not exists (select 1 from public.wa_faq_lookup_tokens where token = '{{cbu}}');
