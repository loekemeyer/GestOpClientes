-- 090 — (APLICADA 29/09 a PaginaLK) pedido_programado dice en qué dirección se entrega (Pablo, 29/09):
-- "Tu pedido del {{1}} ya tiene fecha: lo entregamos el {{2}} en {{3}}." {{3}} = sucursal_entrega del pedido en Gestión
-- (v_pedidos_web; la tienen 192 de 192 pedidos de reparto de los últimos 60 días). Sin dato: "tu dirección de entrega".
-- Rollback: zz_backups.bkp_tracking_notify_20260929 (anterior a 088-090).
do $$
declare d text;
begin
  d := pg_get_functiondef('public.trg_order_tracking_notify()'::regprocedure);
  if position(E'  v_expreso text;\n' in d) = 0
     or position(E'         nullif(btrim(v.nombre_expreso), '''')\n    INTO v_modo, v_expreso' in d) = 0
     or position($x$v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));$x$ in d) = 0 then
    raise exception 'trg_order_tracking_notify: no encontré los tramos a reemplazar';
  end if;
  d := replace(d, E'  v_expreso text;\n', E'  v_expreso text;\n  v_dir text;\n');
  d := replace(d, E'         nullif(btrim(v.nombre_expreso), '''')\n    INTO v_modo, v_expreso',
                  E'         nullif(btrim(v.nombre_expreso), ''''), nullif(btrim(v.sucursal_entrega), '''')\n    INTO v_modo, v_expreso, v_dir');
  d := replace(d, $x$v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));$x$,
                  $x$v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega),
        '3', coalesce(v_dir, 'tu dirección de entrega'));$x$);
  execute d;
end $$;
