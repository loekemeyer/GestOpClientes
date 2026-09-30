-- 111 — (APLICADA 30/09 a PaginaLK) Recordatorio de descuento por vencer (Pablo, 30/09, con el OK de Thomy).
-- El cron bot-recordatorio-25 (jobid 23) pasa a llamar a lk_recordatorio-descuento en días hábiles a las 9:05 AR:
-- 2 días hábiles antes de que venza cada escalón de descuento por pago (factura + 14/30/45/60 al hábil), si la factura
-- sigue con saldo en GV_Cobranza_Deuda_Viva, encola pedido_recordatorio_descuento en wa_outbox (context
-- 'recordatorio_dto'). Sale por lk_outbox-flush detrás de la llave wa_envio_automatico.
-- Antes llamaba a bot_encolar_recordatorios_25(): fecha de salida + 14, bot_facturado_avisos (sin datos desde el
-- 01/09), plantilla pedido_recordatorio_25 inexistente en Meta y el teléfono de Thomy fijo. La función queda sin uso.
-- Rollback: schedule '0 12 * * *', command 'select public.bot_encolar_recordatorios_25()'.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'bot-recordatorio-25'),
  schedule := '5 12 * * 1-5',
  command := $$select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_recordatorio-descuento',
    headers := jsonb_build_object('Content-Type','application/json','x-lk-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'LK_FN_CRON_SECRET' order by created_at desc limit 1)),
    body := '{"aplicar":true}'::jsonb, timeout_milliseconds := 60000)$$);
