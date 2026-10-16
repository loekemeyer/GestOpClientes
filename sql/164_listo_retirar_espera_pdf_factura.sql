-- 164 — "Listo para retirar" sale cuando se SUBE EL PDF DE LA FACTURA, no con la descarga del Excel (proyecto LK)
-- Pedido de Pablo Olejavetzky (16/10/2026): «el trigger tiene que ser cuando se sube el pdf de la factura». Auditoría: problema 855.
--
-- Por qué: wa_avisos_retiro_web (cron lk_aviso-retiro-web, cada 10 min) disparaba con estado = 'facturado' de
-- virgilio.gv_pedido_web_estado_pagina, y ese estado sale de Facturacion_NP, que en Gestión se llena al DESCARGAR EL EXCEL
-- de facturación, no al emitir la factura. Caso real 16/10: LK 0439 (cliente 4210), Excel 12:38:38, aviso 12:39:00, PDF de la
-- factura FC A 0004-00036276 subido 12:52:22. En 30 días de retiros web LK (43 NP) la factura llegó una mediana de 14,7 min
-- después del Excel y el p90 15 h después: el aviso le decía al cliente que pasara a retirar antes de que hubiera factura.
--
-- Ahora, además de todo lo de antes, cada NP del pedido tiene que tener un PDF de factura de venta LK del mismo cliente
-- subido DESPUÉS de su marca en Facturacion_NP (virgilio.comprobantes_venta: created_at + storage_path). Si el pedido tiene
-- varias NP, además tiene que haber al menos tantas facturas distintas del cliente como NP desde la primera marca.
-- Medido contra el cruce oficial de Gestión (gv_cruce_facturacion_nps) en esos 43 NP: 0 sin aviso, 0 adelantados más de
-- 1 hora (11 se adelantan unos minutos porque otra factura del mismo cliente se subió en la misma tanda).
-- No se usa el cruce oficial porque el usuario del FDW (lk_ppp_reader) no tiene permiso sobre GV_Cruce_FC_Asig (darlo es
-- tocar Gestión) y se recalcula cada 30 minutos.
--
-- Objetos nuevos (sólo lectura de Gestión, no se toca nada allá):
--   virgilio.comprobantes_venta suma created_at y storage_path (la vista remota ya los tenía).
--   virgilio.gv_ppp_web_estado (foreign table nueva): pedido web → etiqueta de NP.
-- Rollback: zz_backups.bkp_wa_avisos_retiro_web_20261016 (definición anterior).

create table if not exists zz_backups.bkp_wa_avisos_retiro_web_20261016 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'wa_avisos_retiro_web';
alter table zz_backups.bkp_wa_avisos_retiro_web_20261016 enable row level security;

alter foreign table virgilio.comprobantes_venta
  add column if not exists created_at timestamptz,
  add column if not exists storage_path text;

create foreign table if not exists virgilio.gv_ppp_web_estado (
  empresa text,
  order_id bigint,
  np_label text,
  cod_cliente text
) server virgilio_db options (schema_name 'public', table_name 'gv_ppp_web_estado');

create or replace function public.wa_avisos_retiro_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record; v_nueva boolean;
        v_nps integer; v_ok integer; v_cli text; v_desde timestamptz; v_fc integer;
begin
  v_nueva := coalesce((select (value::jsonb) -> 'pedido_listo_retirar' ->> 'activa' from app_settings
                       where key = 'wa_plantillas_version'), 'pedido_listo_retirar') <> 'pedido_listo_retirar';
  for r in
    select o.id, bcw.whatsapp phone, c.business_name, e.fecha_entrega,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido
    -- v27.61-fdw-1vez: la vista remota (FDW a Gestión) se lee UNA vez y se filtra local antes de unir (2,5 s -> 17 ms)
    from (select order_id, empresa, estado, entregado, fecha_entrega from virgilio.gv_pedido_web_estado_pagina
           where empresa = 'lk' and estado = 'facturado' and not coalesce(entregado, false) offset 0) e
    join lateral (select o0.* from orders o0 where o0.id = e.order_id and o0.sheets_sent
                    and o0.created_at > now() - interval '30 days' offset 0) o on true
    join customers c on c.id = o.customer_id
    join lateral (select b.whatsapp from bot_customer_whatsapps b where b.customer_id = c.id
                  order by b.is_primary desc, b.created_at desc limit 1) bcw on true
    join v_pedidos_web v on v.order_id = o.id and v.linea_rn = 1
    where e.empresa = 'lk' and e.estado = 'facturado' and not coalesce(e.entregado, false)
      and o.sheets_sent and o.created_at > now() - interval '30 days'
      and v.zona_expreso ilike 'retira%'
      and not exists (select 1 from wa_outbox w where w.context = 'retiro_listo' and w.ref_id = o.id::text)
  loop
    -- 'facturado' en Gestión = descargaron el Excel de facturación. La factura existe cuando se sube su PDF:
    -- cada NP del pedido necesita un PDF de factura LK del mismo cliente subido después de su marca.
    select count(*),
           count(*) filter (where exists (
             select 1 from virgilio.comprobantes_venta cv
              where cv.marca = 'LK' and cv.familia = 'factura_venta' and cv.storage_path is not null
                and cv.contraparte_codigo = x.cod_cliente and cv.created_at >= x.facturado_at)),
           min(x.cod_cliente), min(x.facturado_at)
      into v_nps, v_ok, v_cli, v_desde
      from (select f.cod_cliente, f.facturado_at
              from virgilio.gv_ppp_web_estado ne
              join virgilio.facturacion_np f on f.np = ne.np_label
             where ne.empresa = 'lk' and ne.order_id = r.id) x;
    continue when coalesce(v_nps, 0) = 0 or v_ok < v_nps;
    if v_nps > 1 then
      select count(distinct cv.punto_venta || '-' || cv.numero) into v_fc
        from virgilio.comprobantes_venta cv
       where cv.marca = 'LK' and cv.familia = 'factura_venta' and cv.storage_path is not null
         and cv.contraparte_codigo = v_cli and cv.created_at >= v_desde;
      continue when v_fc < v_nps;
    end if;

    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, 'pedido_listo_retirar',
            case when v_nueva
              then jsonb_build_object('1', r.fecha_pedido,
                     '2', coalesce('el ' || wa_fecha_con_dia(r.fecha_entrega::date), 'la fecha acordada'))
              else jsonb_build_object('1', coalesce(nullif(btrim(r.business_name), ''), 'cliente'), '2', r.fecha_pedido)
            end,
            'retiro_listo', r.id::text);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_retiro_web falló: %', sqlerrm;
  return -1;
end $$;

revoke execute on function public.wa_avisos_retiro_web() from anon, authenticated;
