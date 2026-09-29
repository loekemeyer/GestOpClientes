-- 094 — (APLICADA 29/09 a PaginaLK) Sin "Hola X, te escribimos de Loekemeyer" en pedido_en_viaje, pedido_en_viaje_expreso
-- y pedido_entregado (Pablo, 29/09). Se aplica recién después de que Meta aceptó la edición de las 3 (PENDING).
-- pedido_listo_retirar queda para mañana (Meta: 1 edición cada 24 h): ver sql/095.
-- Rollback: zz_backups.bkp_despacho_20260929 y zz_backups.bkp_tracking_notify_20260929 (+ reaplicar 088-093).
create table if not exists zz_backups.bkp_despacho_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('trg_notify_despacho', 'trg_order_tracking_notify');
alter table zz_backups.bkp_despacho_20260929 enable row level security;

do $$
declare t text; n text; v1 text; n1 text; v2 text; n2 text; v3 text; n3 text;
begin
  t := pg_get_functiondef('public.trg_order_tracking_notify()'::regprocedure);
  v1 := $x$      v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
        '2', coalesce(v_fecha_pedido, 'reciente'), '3', v_expreso);$x$;
  n1 := $x$      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'),
        '2', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));  -- sql/094$x$;
  v2 := $x$      v_tpl := 'pedido_entregado';
      v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
        '2', coalesce(v_fecha_pedido, 'reciente'));$x$;
  n2 := $x$      v_tpl := 'pedido_entregado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));  -- sql/094$x$;
  if position(v1 in t) = 0 or position(v2 in t) = 0 then raise exception 'trg_order_tracking_notify: no encontré en_viaje_expreso / entregado'; end if;
  execute replace(replace(t, v1, n1), v2, n2);

  n := pg_get_functiondef('public.trg_notify_despacho()'::regprocedure);
  v3 := $x$      jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'), '2', coalesce(v_fecha_pedido, 'reciente'),
        '3', coalesce(v_direccion, 'tu dirección')),$x$;
  n3 := $x$      jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', coalesce(v_direccion, 'tu dirección')),  -- sql/094$x$;
  if position(v3 in n) = 0 then raise exception 'trg_notify_despacho: no encontré pedido_en_viaje'; end if;
  execute replace(n, v3, n3);
end $$;
