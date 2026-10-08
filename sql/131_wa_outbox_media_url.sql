-- 131_wa_outbox_media_url.sql — la cola puede mandar una IMAGEN (Pablo Olejavetzky, 08/10/2026).
--
-- Una fila con media_url sale como mensaje de imagen por link, con `body` de epígrafe (lk_outbox-flush +
-- _shared/outbox-imagen.ts). Pasa por la misma llave y la misma whitelist que el resto (bot_flush_outbox + wa-guard).
-- Primer uso: la foto del 505 que Damián (Chef 411) pidió el 08/10 y no le llegó (sql/130).
-- bot_flush_outbox no cambia: el flush lee media_url aparte, así no hay que cambiar el tipo que devuelve la RPC.

alter table public.wa_outbox add column if not exists media_url text;

comment on column public.wa_outbox.media_url is
  'Link https a una imagen JPEG o PNG. Si está, la fila sale como mensaje de imagen y body es el epígrafe (sql/131).';
