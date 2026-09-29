-- 096 — (APLICADA 29/09 a PaginaLK) Sistema de versiones de plantillas (Pablo, 29/09): cada 30 min lk_templates
-- templates_promover revisa las versiones nuevas (pedido_recibido_v2, …) y, cuando Meta las aprueba, pasa a mandarlas
-- (app_settings.wa_plantillas_version). No borra nada en Meta. Sin versiones pendientes no hace nada.
select cron.schedule('lk_promover-plantillas', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_templates',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-lk-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'LK_FN_CRON_SECRET' order by created_at desc limit 1)),
    body := '{"action":"templates_promover"}'::jsonb, timeout_milliseconds := 30000);
$$);
