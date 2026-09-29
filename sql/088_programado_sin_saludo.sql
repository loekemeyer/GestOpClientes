-- 088 — (APLICADA 29/09 a PaginaLK) pedido_programado sin la doble presentación (Pablo, 29/09): el cliente ya recibió
-- "Hola X, te escribimos de Loekemeyer" en pedido_recibido. La plantilla queda con 2 variables:
--   {{1}} fecha del pedido (dd/mm) · {{2}} día de salida. Sólo cambia esta plantilla (reparto propio); expreso y retiro siguen igual.
-- Rollback: zz_backups.bkp_tracking_notify_20260929.

create table if not exists zz_backups.bkp_tracking_notify_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'trg_order_tracking_notify';
alter table zz_backups.bkp_tracking_notify_20260929 enable row level security;

do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.trg_order_tracking_notify()'::regprocedure);
  viejo := E'    ELSE\n      v_tpl := ''pedido_programado'';\n    END IF;';
  nuevo := E'    ELSE\n      v_tpl := ''pedido_programado'';\n'
        || E'      -- sql/088: sin saludo ni razón social ({{1}} fecha del pedido, {{2}} día de salida).\n'
        || E'      v_params := jsonb_build_object(''1'', coalesce(v_fecha_pedido, ''reciente''), ''2'', wa_fecha_con_dia(NEW.fecha_entrega));\n'
        || E'    END IF;';
  if position(viejo in d) = 0 then raise exception 'trg_order_tracking_notify: no encontré la rama de pedido_programado'; end if;
  execute replace(d, viejo, nuevo);
end $$;
