-- Merge FAQ #32 (Financiación/cuotas) en FAQ #15 (Medios de pago)
-- Desactivar #32, actualizar #15 con info de cuotas y descuentos
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

-- Actualizar FAQ #15: agregar info de cuotas y descuentos
UPDATE wa_faq
SET bot_response = E'Nuestros medios de pago:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113\n\n💳 *Cuotas y descuentos por pago*:\n• Contado (0-14 días): 25% descuento\n• 30 días: 20% descuento\n• 60 días: 10% descuento\n• 90 días: 5% descuento\n\nPara financiación a medida, consultá con un vendedor.'
WHERE id = 15;

-- Desactivar FAQ #32 (consolidada en #15)
UPDATE wa_faq
SET is_active = false
WHERE id = 32;
