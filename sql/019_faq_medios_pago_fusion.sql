-- Actualiza respuesta de FAQ "Medios de pago" (fusión #7 y #27)
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- Solicitado en sesión Mel 27/8 — consolidar opciones de pago y datos dinámicos

UPDATE wa_faq
SET bot_response = E'💰 *Formas de pago disponibles:*\n\n🏦 *Transferencia bancaria:*\nEmpresa: LOEKEMEYER HNOS. S.R.L.\nBanco: Credicoop\nCuenta Corriente: 027-23874/5\nCBU: {cbu}\nAlias: {alias}\nCUIT: {cuit}\n\n💵 *Efectivo:* En el depósito (Virgilio 2788)\n\n✅ *Cheques:* Aceptamos cheques diferidos\n\n📱 *E-Cheq:* Consultar disponibilidad\n\n📲 *Comprobante de pago:*\nEnviá al sector de Cobranzas → WhatsApp 11 6557-4113\n\n💚 *Descuentos por plazo de pago:*\n• Contado (0-14 días): 25%\n• 30 días: 20%\n• 60 días: 10%\n• 90 días: 5%'
WHERE category = 'pago_cbu_formas';
