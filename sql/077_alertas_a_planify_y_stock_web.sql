-- 077 — (APLICADA 28/09) Alertas → tareas de Planify + cajas comprometidas en pedidos web (proyecto LK)
-- Pedido de Pablo Olejavetzky (28/09).
--
-- 1) Cada alerta nueva de wa_alertas_humano (menos whitelist_gate) dispara lk_alerta-planify, que crea una
--    tarea en Planify (proyecto Gestión, schema planify) si la categoría está en
--    app_settings.wa_alertas_planify. Para pruebas: Planify de Pablo Olejavetzky (employee_id 64).
--    El trigger nunca frena el alta de la alerta.
-- 2) bot_stock_web_comprometido(cods): cajas de pedidos web que todavía NO salieron del depósito
--    de terminado. Estado según Gestión (virgilio.gv_pedido_web_estado_pagina):
--      sin_programar / programado (sin pickear)           → cuentan
--      en_armado / armado / pickeado / facturado / entregado → NO (ya se descontaron del terminado)
--      pedido de los últimos 2 días que Gestión todavía no tiene → cuenta
--    Los pedidos viejos que nunca pasaron a Gestión (anteriores al 04/09, 188) NO cuentan.

insert into app_settings(key, value) values ('wa_alertas_planify',
  '{"employee_id":64,"categorias":["escalation","respuesta_aviso_cambio","alta_cliente","comprobante_recibido","comprobante_error","consulta_stock"]}')
on conflict (key) do nothing;

create or replace function public.trg_alerta_a_planify() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_alerta-planify',
    headers := jsonb_build_object('Content-Type','application/json','x-lk-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='LK_FN_CRON_SECRET' order by created_at desc limit 1)),
    body := jsonb_build_object('alerta_id', new.id), timeout_milliseconds := 10000);
  return new;
exception when others then return new;   -- nunca frena el alta de la alerta
end $$;

drop trigger if exists alerta_a_planify on public.wa_alertas_humano;
create trigger alerta_a_planify after insert on public.wa_alertas_humano
  for each row when (new.tipo <> 'whitelist_gate') execute function public.trg_alerta_a_planify();

create or replace function public.bot_stock_web_comprometido(p_cods text[])
returns table(cod text, cajas numeric, pedidos bigint)
language sql stable security definer set search_path to 'public' as $$
  select p.cod, sum(oi.cajas)::numeric, count(distinct o.id)
  from orders o
  join order_items oi on oi.order_id = o.id
  join products p on p.id = oi.product_id
  left join virgilio.gv_pedido_web_estado_pagina g on g.order_id = o.id and g.empresa = 'lk'
  where p.cod = any(coalesce(p_cods, '{}'))
    and (
      (g.order_id is not null and g.estado in ('sin_programar','programado')
         and not coalesce(g.facturado, false) and not coalesce(g.entregado, false))
      or (g.order_id is null and o.created_at > now() - interval '2 days')
    )
  group by p.cod;
$$;
revoke all on function public.bot_stock_web_comprometido(text[]) from public, anon, authenticated;
grant execute on function public.bot_stock_web_comprometido(text[]) to service_role;

-- Verificación:
--   select tgname from pg_trigger where tgname = 'alerta_a_planify';
--   select * from bot_stock_web_comprometido(array['506']);
-- Apagar Planify: drop trigger alerta_a_planify on public.wa_alertas_humano;
