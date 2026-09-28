-- 081 — wa_outbox.wamid: el ID de Meta de cada aviso que despacha lk_outbox-flush (Pablo Olejavetzky, 28/09).
-- Con esto Centro de mensajes › Salientes cuenta EXACTO qué salió del bot (antes: teléfono ±3 min) y se puede
-- cruzar cada aviso con su estado en wa_message_status (entregado / leído / fallido). Filas viejas quedan en null.
alter table public.wa_outbox add column if not exists wamid text;
create index if not exists wa_outbox_wamid_idx on public.wa_outbox (wamid) where wamid is not null;
