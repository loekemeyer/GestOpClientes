-- 123 — Poda diaria de wa_inbound_seen (auditoría del 02/10/2026, sección 3.4; "sí" de Pablo el 02/10)
--
-- `wa_inbound_seen` es el candado de idempotencia del webhook (sql/057): una fila por wamid recibido. Crece una fila
-- por mensaje y nadie la podaba: 1.359 filas el 02/10. La función `wa_inbound_seen_limpiar(p_dias)` existe desde
-- sql/057 ("sin cron por ahora, la tabla es minúscula") y nunca se agendó.
--
-- 7 días sobra: Meta reintenta un webhook en minutos, y la lógica de ráfaga / saludo suelto mira ventanas de 6 s.
-- 04:15 UTC = 01:15 AR, sin tráfico. `cron.schedule(nombre, …)` hace upsert por nombre: idempotente.
--
-- Aplicada en producción el 02/10/2026 (cron.job 'wa_inbound_seen_limpiar').

select cron.schedule('wa_inbound_seen_limpiar', '15 4 * * *', $$select public.wa_inbound_seen_limpiar(7)$$);

-- ROLLBACK
--   select cron.unschedule('wa_inbound_seen_limpiar');
