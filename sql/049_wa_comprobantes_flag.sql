-- 049_wa_comprobantes_flag.sql
-- Feature flag para el flujo de comprobantes. Por defecto APAGADO.
-- Encender: UPDATE app_settings SET value = '1' WHERE key = 'wa_comprobantes_activo';
--
-- Cuando 0 (default): webhook responde placeholder "no enviar adjuntos".
-- Cuando 1: webhook baja el adjunto de Meta, lo sube a wa-comprobantes,
--           inserta wa_comprobantes, dispara lk_parse-comprobante, responde
--           "muchas gracias" y encola alerta humana.
insert into app_settings (key, value)
values ('wa_comprobantes_activo', '0')
on conflict (key) do nothing;
