-- Unifica FAQ #7 (formas de pago) y #15 (datos transferencia) en una sola
-- Elimina duplicado en ID=7, mantiene ID=15 como respuesta completa
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET is_active = false
WHERE id = 7;

UPDATE wa_faq
SET bot_response = E'Nuestros medios de pago:\n\n💵 *Efectivo*\n🏦 *Transferencia bancaria*\n📝 *Cheques* (a convenir)\n📱 *E-cheq*\n\nPara financiación especial o cuotas sin interés, consultá con tu vendedor asignado.\n\n📋 *Datos para transferencia bancaria:*\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113\n\n💰 *Descuentos por plazo de pago:*\n• Contado (0-14 días): 25%\n• 30 días: 20%\n• 60 días: 10%\n• 90 días: 5%'
WHERE id = 15;
