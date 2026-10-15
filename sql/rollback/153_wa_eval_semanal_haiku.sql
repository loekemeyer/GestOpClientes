-- Rollback de sql/153: saca el cron semanal y la función. La función wa_eval_tick vuelve a la de sql/135 (correrla de nuevo).
-- Las columnas modelo_eval y solo_origen quedan (son nullable y la 135 no las lee): borrarlas sería DDL que borra datos.
select cron.unschedule('lk_eval-semanal-haiku');
drop function if exists public.wa_eval_corrida_modelo(text, text, text);
-- y después: \i sql/135_wa_eval_solo_gratis.sql
