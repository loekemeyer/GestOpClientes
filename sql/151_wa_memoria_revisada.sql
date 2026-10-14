-- 151 · proteger las fichas revisadas a mano del cron incremental (Pablo Olejavetzky, 14/10/2026, P3)
--
-- El cron lk_memoria-incremental (cada hora) rearma la ficha pasándole la ficha ACTUAL + la charla nueva a Haiku,
-- así que una ficha editada a mano queda a merced del modelo en la próxima corrida (el ESTADO del 14/10 ya lo marcó:
-- "lo editado no queda bloqueado"). Con revisada_por cargado, el incremental la SALTEA (corte antes de llamar al
-- modelo, US$ 0) y la ficha queda congelada hasta que alguien borre revisada_por. La memoria del año a demanda
-- (buscar_en_mi_historial, sql/149) igual ve las charlas nuevas en bot_historial_chat.
--
-- Además es la columna que pedía el criterio de P3.1 ("las fichas del piloto tienen revisada_por cargado").
-- Idempotente. Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg).

alter table public.wa_memoria_cliente add column if not exists revisada_por text;
alter table public.wa_memoria_cliente add column if not exists revisada_en  timestamptz;

-- Marcar como revisadas las dos fichas del piloto que ya se corrigieron a mano el 14/10 (3790 y 3969, ver ESTADO),
-- para que el próximo incremental no las pise. (Las ejecuta este mismo archivo; 1 fila por UPDATE.)
update public.wa_memoria_cliente
   set revisada_por = 'Pablo (correccion manual 14/10)', revisada_en = now()
 where marca = 'LK' and cod_cli in (3790, 3969) and revisada_por is null;
