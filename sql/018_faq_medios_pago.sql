-- Actualiza FAQ #15 "Medios de pago" (fusión #7 y #15)
-- ID=15, category=pago_cbu_formas
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Nuestros medios de pago:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\nPara financiación especial o cuotas, consultá con tu vendedor asignado.\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {cbu}\n📝 CUIT: {cuit}\nAlias: {alias}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas (WhatsApp 11 6557-4113). ✅'
WHERE id = 15;
