-- 093 — (APLICADA 29/09 a PaginaLK) pedido_recibido saluda "¡Hola!" sin la razón social (Pablo, 29/09: "es muy repetitivo").
-- La plantilla pasa a 4 variables: {{1}} fecha del pedido, {{2}} total, {{3}} método de pago, {{4}} entrega estimada.
-- Rollback: zz_backups.bkp_fecha_estimada_20260929 (definición anterior de trg_notify_order_created, sql/087).
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.trg_notify_order_created()'::regprocedure);
  viejo := $x$      '1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '3', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '4', wa_metodo_pago_texto(NEW.payment_method),
      '5', coalesce(v_est.texto, 'a confirmar')),$x$;
  nuevo := $x$      '1', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '2', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '3', wa_metodo_pago_texto(NEW.payment_method),
      '4', coalesce(v_est.texto, 'a confirmar')),  -- sql/093: sin razón social$x$;
  if position(viejo in d) = 0 then raise exception 'trg_notify_order_created: no encontré los parámetros de pedido_recibido'; end if;
  execute replace(d, viejo, nuevo);
end $$;
