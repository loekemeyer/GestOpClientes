-- (APLICADA 29/09 a PaginaLK)
-- 087 — pedido_recibido con el texto de Pablo (29/09): "Entrega estimada: <día>." + "En breve te confirmamos el día exacto
-- de programación." La variable {{5}} pasa a ser sólo el día, con la aclaración de expreso o retiro entre paréntesis:
--   reparto → "martes 20/10"
--   expreso → "martes 20/10 (te lo dejamos en el expreso)"
--   retira  → "martes 20/10 (listo para retirar)"   ·  día elegido en la web → "miércoles 30/09, de 9:00 a 12:00 (el día que elegiste para retirar)"
--   sin estimación → "a confirmar"
-- Rollback: zz_backups.bkp_fecha_estimada_20260929 (definiciones anteriores).

create table if not exists zz_backups.bkp_fecha_estimada_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('wa_fecha_estimada_calc', 'trg_notify_order_created');
alter table zz_backups.bkp_fecha_estimada_20260929 enable row level security;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_fecha_estimada_calc(bigint)'::regprocedure);
  if position($x$'lo retirás el ' || wa_fecha_con_dia(v_rfecha) || coalesce(', de ' || v_rfranja, '')$x$ in d) = 0
     or position($x$when 'retira'  then 'va a estar listo para retirar antes del ' || wa_fecha_con_dia(fecha)$x$ in d) = 0 then
    raise exception 'wa_fecha_estimada_calc: no encontré los textos a reemplazar';
  end if;
  d := replace(d, $x$'lo retirás el ' || wa_fecha_con_dia(v_rfecha) || coalesce(', de ' || v_rfranja, '')$x$,
                  $x$wa_fecha_con_dia(v_rfecha) || coalesce(', de ' || v_rfranja, '') || ' (el día que elegiste para retirar)'$x$);
  d := replace(d, $x$when 'retira'  then 'va a estar listo para retirar antes del ' || wa_fecha_con_dia(fecha)$x$,
                  $x$when 'retira'  then wa_fecha_con_dia(fecha) || ' (listo para retirar)'$x$);
  d := replace(d, $x$when 'expreso' then 'lo despachamos al expreso antes del ' || wa_fecha_con_dia(fecha)$x$,
                  $x$when 'expreso' then wa_fecha_con_dia(fecha) || ' (te lo dejamos en el expreso)'$x$);
  d := replace(d, $x$else 'sale antes del ' || wa_fecha_con_dia(fecha) end;$x$, $x$else wa_fecha_con_dia(fecha) end;$x$);
  execute d;

  d := pg_get_functiondef('public.trg_notify_order_created()'::regprocedure);
  if position($x$'te la confirmamos cuando entre en programación'$x$ in d) = 0 then
    raise exception 'trg_notify_order_created: no encontré el texto por defecto';
  end if;
  execute replace(d, $x$'te la confirmamos cuando entre en programación'$x$, $x$'a confirmar'$x$);
end $$;
