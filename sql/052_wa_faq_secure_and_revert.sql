-- 052 — Cerrar escritura anon en wa_faq + revertir tokenización indebida
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
--
-- Contexto:
--   - 051 abrió `anon_update` en wa_faq para que el front pudiera guardar.
--     Pero la anon key es pública (está en el HTML), así que eso deja escribir
--     a cualquiera por REST salteando la UI. La escritura pasa a ir por la
--     Edge Function `lk_faq-admin`, que valida que el usuario sea admin.
--   - 051 tokenizó `institutional_response` (*----* → {{fecha}}). Ese campo lo
--     sirve el bot a NO-clientes, que nunca tienen pedido: el token nunca se
--     puede completar. Los tokens de dato solo van donde el bot puede llenarlos.
--
-- Idempotente.

-- 1. Cerrar UPDATE anon: la escritura pasa por la edge function (service_role).
drop policy if exists "anon_update" on wa_faq;

-- (Se conserva "anon_read" para que el dashboard pueda LEER las FAQs.)

-- 2. Revertir el placeholder de institutional_response al original (*----------*).
update wa_faq
   set institutional_response = replace(institutional_response, '{{fecha}}', '*----------*')
 where institutional_response like '%{{fecha}}%';
