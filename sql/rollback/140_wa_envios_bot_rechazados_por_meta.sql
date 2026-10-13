-- Rollback de sql/140: saca el trigger y la función. La tabla se deja (es historial); borrarla es decisión aparte.
drop trigger if exists wa_envio_fallido on public.wa_message_status;
drop function if exists public.trg_wa_envio_fallido();
-- drop table if exists public.wa_envios_bot;   -- sólo con el "sí" (regla de BD: borrados)
