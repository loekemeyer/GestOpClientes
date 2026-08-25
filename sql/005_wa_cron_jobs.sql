-- pg_cron jobs para el bot WhatsApp
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- NOTA: requiere extensión pg_cron habilitada

-- 1. Flush outbox cada 2 minutos
select cron.schedule(
  'wa_outbox_flush',
  '*/2 * * * *',
  $$select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_whatsapp-webhook',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"action":"flush"}'
  )$$
);

-- 2. Expirar drafts viejos cada 5 minutos
select cron.schedule(
  'wa_expire_drafts',
  '*/5 * * * *',
  $$select wa_expire_old_drafts()$$
);

-- 3. Reactivación clientes inactivos — lunes 13:00 UTC (10:00 AR)
select cron.schedule(
  'wa_reactivacion_clientes',
  '0 13 * * 1',
  $$insert into wa_outbox (phone, template_name, template_params, customer_id)
    select cp.phone, 'reactivacion_cliente',
           jsonb_build_object('name', c.business_name, 'days', extract(day from now() - max(o.created_at))::int),
           c.id
    from customers c
    join customer_phones cp on cp.customer_id = c.id and cp.opt_out = false
    join orders o on o.customer_id = c.id
    left join wa_outbox wo on wo.customer_id = c.id
      and wo.template_name = 'reactivacion_cliente'
      and wo.created_at > now() - interval '30 days'
    where wo.id is null  -- no enviado en últimos 30 días
    group by c.id, c.business_name, c.cod_cliente, cp.phone
    having max(o.created_at) < now() - interval '90 days'$$
);
