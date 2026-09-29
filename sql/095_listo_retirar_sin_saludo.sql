-- 095 — (PENDIENTE: aplicar DESPUÉS de que Meta acepte la edición de pedido_listo_retirar; hoy 29/09 la rechazó por el
-- límite de 1 edición cada 24 h. La aplica la tarea programada del 30/09.) Sin la doble presentación (Pablo, 29/09):
-- pedido_listo_retirar pasa a 1 variable ({{1}} fecha del pedido). Lo mandan trg_notify_despacho y wa_avisos_retiro_web.
do $$
declare n text; r text; v1 text; v2 text;
begin
  n := pg_get_functiondef('public.trg_notify_despacho()'::regprocedure);
  r := pg_get_functiondef('public.wa_avisos_retiro_web()'::regprocedure);
  v1 := $x$jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'), '2', coalesce(v_fecha_pedido, 'reciente')),
      'despacho', NEW.np);$x$;
  v2 := $x$jsonb_build_object('1', coalesce(nullif(btrim(r.business_name), ''), 'cliente'), '2', r.fecha_pedido),$x$;
  if position(v1 in n) = 0 or position(v2 in r) = 0 then raise exception 'no encontré los parámetros de pedido_listo_retirar'; end if;
  execute replace(n, v1, $x$jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente')),  -- sql/095
      'despacho', NEW.np);$x$);
  execute replace(r, v2, $x$jsonb_build_object('1', r.fecha_pedido),  -- sql/095$x$);
end $$;
