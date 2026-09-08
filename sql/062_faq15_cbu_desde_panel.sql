-- 062_faq15_cbu_desde_panel.sql
-- Punto 22 auditoría: FAQ 15 ("medios de pago", full_auto) tenía el CBU y el alias
-- HARDCODEADOS en el texto → cambiar el CBU en el Panel NO lo actualizaba (sí a la FAQ 42
-- datos_transferencia, que ya usa tokens). Inconsistencia: "pasame el CBU" daba el nuevo,
-- "medios de pago" el viejo.
--
-- Fix: FAQ 15 pasa a leer alias/CBU del Panel igual que la 42 → tokens {{alias}}/{{cbu}} +
-- db_lookup_type='payment_data' (lo resuelve lookupPaymentData en faq.ts, sirve a cliente y
-- no-cliente desde app_settings.wa_descuentos_config.pago). Banco y Titular quedan literales
-- (no viven en la config; son estables). automation_level pasa a semi_auto (ahora hace lookup).
--
-- Backup de la fila en public.wa_faq_bkp_20260908_faq15. Idempotente.

create table if not exists public.wa_faq_bkp_20260908_faq15 as
  select * from public.wa_faq where id = 15;

update public.wa_faq set
  bot_response =
    'Nuestros medios de pago son:' || chr(10) || chr(10) ||
    '💵 Efectivo' || chr(10) ||
    '🏦 Transferencia bancaria' || chr(10) ||
    '📝 Cheques (a convenir)' || chr(10) ||
    '📱 E-cheq' || chr(10) || chr(10) ||
    '📋 Datos para transferencia bancaria:' || chr(10) ||
    '🏦 Banco: Credicoop' || chr(10) ||
    '👤 Titular: Loekemeyer S.A.' || chr(10) ||
    '🔢 *CBU:* {{cbu}}' || chr(10) ||
    '*Alias:* {{alias}}' || chr(10) || chr(10) ||
    'Una vez hecha la transferencia, enviá el comprobante al sector de cobranzas:' || chr(10) ||
    '📲 WhatsApp 11 6557-4113',
  automation_level = 'semi_auto',
  requires_db_lookup = true,
  db_lookup_type = 'payment_data',
  updated_at = now()
where id = 15;
