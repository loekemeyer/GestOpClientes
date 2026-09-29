-- 089 — (APLICADA 29/09 a PaginaLK) pedido_programado_expreso sin la doble presentación (Pablo, 29/09):
-- "Tu pedido del {{1}} ya tiene fecha: lo despachamos el {{2}} a Expreso {{3}}. Te avisamos cuando lo entreguemos al expreso."
-- {{3}} = nombre del expreso sin la palabra "Expreso" (9 de 168 nombres la traen: si no, diría "Expreso Expreso …").
-- Rollback: zz_backups.bkp_tracking_notify_20260929 (guardada en sql/088, antes de ambos cambios).
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.trg_order_tracking_notify()'::regprocedure);
  viejo := E'      v_tpl := ''pedido_programado_expreso'';\n      v_params := v_params || jsonb_build_object(''4'', v_expreso);';
  nuevo := E'      v_tpl := ''pedido_programado_expreso'';\n'
        || E'      -- sql/089: sin saludo; {{1}} fecha del pedido, {{2}} día de salida, {{3}} expreso sin "Expreso".\n'
        || E'      v_params := jsonb_build_object(''1'', coalesce(v_fecha_pedido, ''reciente''), ''2'', wa_fecha_con_dia(NEW.fecha_entrega),\n'
        || E'        ''3'', regexp_replace(v_expreso, ''^\\s*expreso\\s+'', '''', ''i''));';
  if position(viejo in d) = 0 then raise exception 'trg_order_tracking_notify: no encontré la rama de pedido_programado_expreso'; end if;
  execute replace(d, viejo, nuevo);
end $$;
