-- 165 — El agente dice "facturado" sólo cuando se subió el PDF de la factura (proyecto LK)
-- Pedido de Pablo Olejavetzky (16/10/2026, D045): «Si hacelo», sobre el caso hermano del aviso de retiro (sql/164). Auditoría: problema 856.
--
-- Por qué: bot_estado_pedidos_gv (sql/066) devolvía 'facturado' con la marca facturado de Gestión, que sale de Facturacion_NP y se llena
-- al DESCARGAR EL EXCEL de facturación, no al emitir la factura. Todo lo que lee esa RPC le decía al cliente "facturado, listo para
-- retirar" o "listo para salir" hasta 15 h antes de que la factura existiera: lookupOrderStatus (faq.ts, fecha-retiro.ts),
-- consultar_mis_pedidos del agente (bot-conversation.ts), agregado-armado ("ya está facturado"), el dashboard de conversaciones y la
-- vista previa de plantillas.
--
-- Ahora la regla de sql/164 vive en UNA función, wa_factura_pdf_subida(order_id), y la usan las dos:
--   * bot_estado_pedidos_gv: con la marca de Gestión pero sin PDF de factura devuelve 'en preparacion' (el pedido está armado,
--     esperando la factura). Para retiro se lee "en preparación en el depósito: va a estar listo para retirar desde el …".
--   * wa_avisos_retiro_web: misma lógica que sql/164, ahora llamando a la función (sin copia de la regla).
-- Si la lectura de Gestión falla, wa_factura_pdf_subida devuelve false: no se afirma una factura que no se pudo ver.
-- Rollback: zz_backups.bkp_bot_estado_pedidos_gv_20261016 (definición anterior) + zz_backups.bkp_wa_avisos_retiro_web_20261016.

create table if not exists zz_backups.bkp_bot_estado_pedidos_gv_20261016 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'bot_estado_pedidos_gv';
alter table zz_backups.bkp_bot_estado_pedidos_gv_20261016 enable row level security;

-- ¿Ya se subió el PDF de la factura de TODAS las NP del pedido web LK? Cada NP necesita un PDF de factura de venta LK del mismo
-- cliente subido después de su marca en Facturacion_NP (= descarga del Excel). Con varias NP, además tantas facturas distintas
-- del cliente como NP desde la primera marca. Medido el 16/10 en 43 NP de retiro contra el cruce oficial de Gestión: 0 sin
-- factura reconocida, 0 adelantados más de 1 hora.
create or replace function public.wa_factura_pdf_subida(p_order_id bigint)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare v_nps integer; v_ok integer; v_cli text; v_desde timestamptz; v_fc integer;
begin
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
           where ne.empresa = 'lk' and ne.order_id = p_order_id) x;
  if coalesce(v_nps, 0) = 0 or v_ok < v_nps then return false; end if;
  if v_nps > 1 then
    select count(distinct cv.punto_venta || '-' || cv.numero) into v_fc
      from virgilio.comprobantes_venta cv
     where cv.marca = 'LK' and cv.familia = 'factura_venta' and cv.storage_path is not null
       and cv.contraparte_codigo = v_cli and cv.created_at >= v_desde;
    return v_fc >= v_nps;
  end if;
  return true;
exception when others then
  raise warning 'wa_factura_pdf_subida(%) falló: %', p_order_id, sqlerrm;
  return false;
end $$;

revoke execute on function public.wa_factura_pdf_subida(bigint) from public, anon, authenticated;

create or replace function public.bot_estado_pedidos_gv(p_ids bigint[])
 returns table(order_id bigint, status text, fecha_entrega date, fuente text)
 language sql stable security definer set search_path to 'public' as $function$
  with g as (
    select g.order_id, g.estado, g.fecha_entrega, g.entregado, g.facturado, g.entregado_at
      from virgilio.gv_pedido_web_estado_pagina g
     where g.empresa = 'lk' and g.order_id = any(coalesce(p_ids, '{}'))
  )
  select i.id,
         case
           when g.order_id is not null then
             case when g.entregado            then 'entregado'
                  -- 'facturado' en Gestión = descargaron el Excel (sql/165): sin el PDF de la factura sigue "en preparación"
                  when g.facturado            then case when public.wa_factura_pdf_subida(g.order_id) then 'facturado' else 'en preparacion' end
                  when g.estado = 'programado' then 'programado'
                  when g.estado = 'sin_programar' then 'recibido'
                  else 'en preparacion' end
           when lower(ot.status) in ('recibido','programado','entregado','a programar','a_programar')
             then lower(ot.status)
           else 'recibido'
         end,
         case
           when g.order_id is not null then
             case when g.entregado then coalesce((g.entregado_at at time zone 'America/Argentina/Buenos_Aires')::date, g.fecha_entrega)
                  when g.estado = 'sin_programar' then null   -- sin programar: no se promete fecha
                  else g.fecha_entrega end
           when lower(ot.status) in ('programado','entregado') then ot.fecha_entrega
         end,
         case when g.order_id is not null then 'gestion'
              when ot.np_number is not null then 'planilla'
              else 'sin_dato' end
    from unnest(coalesce(p_ids, '{}')) i(id)
    left join g on g.order_id = i.id
    left join public.order_tracking ot on ot.np_number = i.id::text;
$function$;

create or replace function public.wa_avisos_retiro_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record; v_nueva boolean;
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
    -- 'facturado' en Gestión = descargaron el Excel de facturación. El aviso espera el PDF de la factura (sql/164 y 165).
    continue when not public.wa_factura_pdf_subida(r.id);
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
