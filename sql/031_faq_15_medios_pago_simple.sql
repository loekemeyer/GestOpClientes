-- FAQ #15: Medios de pago - VERSIÓN SIMPLE (sin cuotas)
-- Solo medios de pago + datos bancarios
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET
  automation_level = 'full_auto',
  bot_response = E'Nuestros medios de pago son:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113',
  web_first_response = NULL,
  is_active = true
WHERE id = 15;
