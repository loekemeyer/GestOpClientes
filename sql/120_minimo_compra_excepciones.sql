-- 120 — Pedido mínimo que informa el bot: general + excepciones por cliente (Pablo Olejavetzky, 01/10).
--
-- Antes: $500.000 / $300.000 escritos a mano en el texto de la FAQ #21 y #31 y en el prompt del agente.
-- Ahora:
--   app_settings.wa_minimo_compra = {"envio": 500000, "retiro": 300000}   ← el general
--   wa_minimo_excepciones                                                  ← por cliente (customers.id)
--     minimo_envio / minimo_retiro: null = usa el general · 0 = sin mínimo · otro = ese monto
-- La FAQ #31 (envíos) y la #21 (mínimo) pasan a semi_auto con db_lookup_type 'minimo_compra' (faq.ts lookupMinimo):
-- {{minimo_envio}} y {{minimo_retiro}} salen del cliente que escribe; a un no-cliente, el general.
-- Si el cliente pide una excepción que no está cargada, la IA deriva (motivo excepcion_minimo): lo decide un vendedor.
-- Es sólo informativo: NO cambia wa_pedidos_config.minimo_envio/_retiro (el aviso en pedidos por WhatsApp, vacío a
-- propósito desde el 30/09) ni frena ningún pedido.
-- La #31 deja de prometer plazo ("7-15 días hábiles"): "¿cuánto tarda?" lo contesta lookupOrderStatus (faq.ts, plazo).
-- Idempotente.

create table if not exists public.wa_minimo_excepciones (
  customer_id   uuid primary key references public.customers(id) on delete cascade,
  cod_cliente   bigint,
  business_name text,
  minimo_envio  numeric check (minimo_envio is null or minimo_envio >= 0),
  minimo_retiro numeric check (minimo_retiro is null or minimo_retiro >= 0),
  nota          text,
  cargado_por   text,
  updated_at    timestamptz not null default now()
);
alter table public.wa_minimo_excepciones enable row level security;  -- sin políticas: sólo service_role (lk_alertas, el bot)
create index if not exists wa_minimo_excepciones_cod on public.wa_minimo_excepciones (cod_cliente);

insert into public.app_settings (key, value)
values ('wa_minimo_compra', '{"envio":500000,"retiro":300000}')
on conflict (key) do nothing;

update public.wa_faq set
  automation_level = 'semi_auto', requires_db_lookup = true, db_lookup_type = 'minimo_compra', updated_at = now(),
  bot_response = E'🚚 ¡Hacemos envíos a todo el país!\n\n📍 *CABA y GBA*: con nuestro camión.\n📍 *Interior*: lo dejamos en el expreso que elijas; el flete del expreso corre por tu cuenta.\n📍 También podés retirarlo en el depósito (Virgilio 2788, Villa Devoto).\n\n💰 *Pedido mínimo*\n• Con envío (CABA, GBA o expreso): {{minimo_envio}}\n• Si lo retirás en el depósito: {{minimo_retiro}}'
where id = 31;

update public.wa_faq set
  automation_level = 'semi_auto', requires_db_lookup = true, db_lookup_type = 'minimo_compra', updated_at = now(),
  bot_response = E'💰 *Pedido mínimo*\n• Con envío (CABA, GBA o expreso): {{minimo_envio}}\n• Si lo retirás en el depósito: {{minimo_retiro}}\n\n{{si_no_llega_al_minimo}}\nLos retiros son en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30.'
where id = 21;

insert into public.wa_faq_lookup_tokens (db_lookup_type, token, label, descripcion, is_block, ejemplo, sort_order)
select v.* from (values
  ('minimo_compra', 'minimo_envio', 'Mínimo con envío',
   'Pedido mínimo con envío del cliente: su excepción (Configuración del agente › Pedidos por WhatsApp › Pedido mínimo) o el general. A un no-cliente, el general.',
   false, '$500.000', 10),
  ('minimo_compra', 'minimo_retiro', 'Mínimo para retirar',
   'Pedido mínimo si retira en el depósito: su excepción o el general.', false, '$300.000', 20),
  ('minimo_compra', 'si_no_llega_al_minimo', 'Si no llega al mínimo (bloque)',
   'Ofrece prepararlo para retirar cuando el mínimo de retiro es menor que el de envío; si no, queda vacío y la línea se saca.',
   true, 'Si tu pedido no llega al mínimo de envío, lo podemos preparar para que lo retires: confirmanos si querés.', 30)
) as v(db_lookup_type, token, label, descripcion, is_block, ejemplo, sort_order)
where not exists (select 1 from public.wa_faq_lookup_tokens t where t.db_lookup_type = v.db_lookup_type and t.token = v.token);
