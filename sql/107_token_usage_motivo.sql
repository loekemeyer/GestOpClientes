-- 107 — (APLICADA 29/09 a PaginaLK) Gasto de IA por motivo (Pablo, 29/09: "tablero de gasto por día y motivo").
-- bot_token_usage.motivo = para qué consultó el cliente en ese turno (pago, entrega, stock, productos, cambio_pedido,
-- reclamo…), deducido de las herramientas que usó la IA (bot-conversation.ts, motivoDelTurno). Las filas anteriores
-- quedan sin motivo. Lo lee lk_ia-puntaje action "gasto" para el Dashboard › IA — gasto por día y motivo.
alter table public.bot_token_usage add column if not exists motivo text;
create index if not exists bot_token_usage_created_at on public.bot_token_usage (created_at desc);
