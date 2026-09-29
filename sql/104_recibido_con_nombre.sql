-- 104 — (APLICADA 29/09 a PaginaLK) pedido_recibido vuelve a saludar con la razón social (Pablo, 29/09: "si tenemos que
-- poner el nombre de la persona, por ser el primer mensaje"). Revierte sql/093: vuelven los 5 parámetros
-- {{1}} razón social, {{2}} fecha del pedido, {{3}} total, {{4}} método de pago, {{5}} entrega estimada.
-- Además arregla una falla latente: la plantilla APROBADA en Meta tiene 5 variables (la edición a 4 de sql/093 la rechazó
-- Meta por el límite de 24 h), así que desde sql/093 el próximo pedido_recibido iba a fallar (0 casos: no hubo pedidos).
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.trg_notify_order_created()'::regprocedure);
  viejo := $x$      '1', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '2', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '3', wa_metodo_pago_texto(NEW.payment_method),
      '4', coalesce(v_est.texto, 'a confirmar')),  -- sql/093: sin razón social$x$;
  nuevo := $x$      '1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '3', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '4', wa_metodo_pago_texto(NEW.payment_method),
      '5', coalesce(v_est.texto, 'a confirmar')),  -- sql/104: con razón social (primer mensaje)$x$;
  if position(viejo in d) = 0 then raise exception 'trg_notify_order_created: no encontré los parámetros de sql/093'; end if;
  execute replace(d, viejo, nuevo);
end $$;
