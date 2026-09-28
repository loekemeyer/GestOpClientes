-- 076 — (PENDIENTE de aplicar) wa_message_status guarda DESDE QUÉ NÚMERO de Meta salió cada mensaje (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09). El webhook recibe los estados de TODO lo que sale por el número/app
-- (bot, Business Suite, otros sistemas). El 24/09 hubo 722 mensajes a 72 destinatarios que no salieron del
-- bot, y el mail de fallas (lk_fallas-mail) los mezcla. Con phone_number_id se puede separar.
-- Viene en entry[].changes[].value.metadata; lo carga lk_whatsapp-webhook (ingestStatuses). Las filas
-- anteriores quedan en null (Meta no lo mandaba dentro de cada status y no se guardó).

alter table public.wa_message_status add column if not exists phone_number_id text;
alter table public.wa_message_status add column if not exists display_phone_number text;

-- Verificación: select phone_number_id, display_phone_number, count(*) from wa_message_status
--               where received_at > now() - interval '1 day' group by 1,2;
-- Rollback: alter table public.wa_message_status drop column phone_number_id, drop column display_phone_number;
