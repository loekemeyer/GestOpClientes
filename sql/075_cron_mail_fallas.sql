-- 075 — (APLICADA 28/09) Cron del mail de fallas del bot (proyecto LK). Pedido de Pablo Olejavetzky.
-- Cada 10 min llama a lk_fallas-mail (x-lk-secret = LK_FN_CRON_SECRET del Vault). La función manda UN
-- mail a loekemeyer.n8n@gmail.com sólo si hay algo nuevo: rechazos de Meta (wa_message_status failed),
-- filas muertas de wa_outbox y alertas vencidas sin atender. Estado en app_settings.wa_fallas_mail_ultimo.
-- Es mail interno: no pasa por la llave de WhatsApp ni contacta clientes.

select cron.unschedule('lk_fallas_mail') where exists (select 1 from cron.job where jobname = 'lk_fallas_mail');

select cron.schedule('lk_fallas_mail', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_fallas-mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-lk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'LK_FN_CRON_SECRET'
                      order by created_at desc limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000) $$);

-- Verificación: select jobname, schedule, active from cron.job where jobname = 'lk_fallas_mail';
-- Apagar:       select cron.unschedule('lk_fallas_mail');
