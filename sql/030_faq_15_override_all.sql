-- OVERRIDE FINAL: FAQ #15 - Respuesta completa con cuotas, sin web_first
-- Esta SQL debe ser la ÚLTIMA aplicada a FAQ #15 - no más cambios después
-- Reemplaza completamente cualquier contenido anterior
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET
  automation_level = 'full_auto',
  bot_response = E'Nuestros medios de pago:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113\n\n💳 Cuotas y descuentos por pago:\n• Contado (0-14 días): 25% descuento\n• 30 días: 20% descuento\n• 60 días: 10% descuento\n• 90 días: 5% descuento\n\nPara financiación a medida, consultá con un vendedor.',
  web_first_response = NULL,
  is_active = true
WHERE id = 15;
