-- 092 — (APLICADA 29/09 a PaginaLK) Sin "Hola X, te escribimos de Loekemeyer" en todos los programados (Pablo, 29/09):
-- pedido_programado_retira y pedido_reprogramado pasan a 2 variables ({{1}} fecha del pedido, {{2}} día).
-- (pedido_programado y _expreso ya se cambiaron en 088-090.) Rollback: zz_backups.bkp_tracking_notify_20260929.
do $$
declare d text; a_viejo text; a_nuevo text; b_viejo text; b_nuevo text;
begin
  d := pg_get_functiondef('public.trg_order_tracking_notify()'::regprocedure);
  a_viejo := E'    IF v_modo = ''retira'' THEN\n      v_tpl := ''pedido_programado_retira'';\n';
  a_nuevo := E'    IF v_modo = ''retira'' THEN\n      v_tpl := ''pedido_programado_retira'';\n'
          || E'      v_params := jsonb_build_object(''1'', coalesce(v_fecha_pedido, ''reciente''), ''2'', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092\n';
  b_viejo := E'    v_params := jsonb_build_object(''1'', coalesce(nullif(btrim(v_customer_name), ''''), ''cliente''),\n      ''2'', coalesce(v_fecha_pedido, ''reciente''), ''3'', wa_fecha_con_dia(NEW.fecha_entrega));\n  ELSIF TG_OP = ''UPDATE'' AND v_status_cambio AND NEW.status = ''entregado''';
  b_nuevo := E'    v_params := jsonb_build_object(''1'', coalesce(v_fecha_pedido, ''reciente''), ''2'', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092\n  ELSIF TG_OP = ''UPDATE'' AND v_status_cambio AND NEW.status = ''entregado''';
  if position(a_viejo in d) = 0 or position(b_viejo in d) = 0 then
    raise exception 'trg_order_tracking_notify: no encontré las ramas de retira / reprogramado';
  end if;
  execute replace(replace(d, a_viejo, a_nuevo), b_viejo, b_nuevo);
end $$;
