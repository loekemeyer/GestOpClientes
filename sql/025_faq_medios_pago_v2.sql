-- Actualiza FAQ #15 "Medios de pago / Datos bancarios" con respuesta mejorada
-- Especifica medios de pago y datos para transferencia con contacto de cobranzas
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Nuestros medios de pago:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113'
WHERE id = 15;
