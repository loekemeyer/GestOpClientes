-- ⚠ CORREGIDO 2026-09-08 (punto 22 de la auditoria del 07/09).
-- Este archivo escribia los tokens con UNA llave ({cbu}, {alias}) y `renderTemplate`
-- (_shared/faq.ts) solo entiende DOS ({{...}}). O sea que re-correr este archivo tal como
-- estaba le mandaba al cliente, literalmente, "CBU: {cbu}". La fila viva estaba bien porque
-- alguien la habia arreglado a mano por el Panel, asi que el defecto vivia solo en el repo,
-- esperando a que alguien re-corriera la migracion.
-- {cuit} ademas no es un token que exista en ningun lookup: se reemplazo por el valor.

-- FAQ #15: Medios de pago - VERSIÓN SIMPLE (sin cuotas)
-- Solo medios de pago + datos bancarios
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET
  automation_level = 'full_auto',
  bot_response = E'Nuestros medios de pago son:\n\n💵 Efectivo\n🏦 Transferencia bancaria\n📝 Cheques (a convenir)\n📱 E-cheq\n\n📋 Datos para transferencia bancaria:\n🏦 Banco: Credicoop\n👤 Titular: Loekemeyer S.A.\n🔢 CBU: {{cbu}}\n📝 CUIT: 30-71234567-8\nAlias: {{alias}}\n\nUna vez hecha la transferencia, enviá el comprobante al sector de cobranzas:\n📲 WhatsApp 11 6557-4113',
  web_first_response = NULL,
  is_active = true
WHERE id = 15;
