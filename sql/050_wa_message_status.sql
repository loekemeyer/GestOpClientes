-- 050_wa_message_status.sql
-- Captura los delivery status que Meta manda al webhook por cada mensaje saliente.
-- Cloud API v20+ los rutea junto al campo `messages` del webhook (dentro de
-- `entry[].changes[].value.statuses[]`) — no requiere suscripción separada.
--
-- Estados típicos: sent → delivered → read (o failed).
-- Cuando el cliente responde, además viene un evento "customer_service_window"
-- que arma la ventana de 24 h.

create table if not exists wa_message_status (
  id              bigserial primary key,
  wamid           text not null,                    -- id del mensaje (wamid.HBg…)
  recipient_id    text,                             -- teléfono del destinatario (canónico)
  status          text not null,                    -- sent | delivered | read | failed | deleted | ...
  ts              timestamptz not null,             -- timestamp reportado por Meta
  conversation_id text,                             -- id de conversación de billing
  conv_expiration timestamptz,                      -- vence la ventana de facturación
  origin_type     text,                             -- authentication | marketing | utility | service
  pricing_category text,
  pricing_type    text,
  errors          jsonb,                            -- [{code, title, message, ...}] cuando status=failed
  raw             jsonb not null,                   -- payload entero para debug
  received_at     timestamptz not null default now(),
  unique (wamid, status)                            -- idempotencia (Meta reintenta webhooks)
);

create index if not exists wa_message_status_wamid_idx      on wa_message_status(wamid);
create index if not exists wa_message_status_recipient_idx  on wa_message_status(recipient_id);
create index if not exists wa_message_status_ts_idx         on wa_message_status(ts desc);
create index if not exists wa_message_status_failed_idx     on wa_message_status(received_at desc) where status = 'failed';

comment on table wa_message_status is
  'Delivery status por wamid — poblado por el webhook lk_whatsapp-webhook al recibir events.statuses[]. Habilita saber sent/delivered/read/failed sin pedirlo a Meta.';
