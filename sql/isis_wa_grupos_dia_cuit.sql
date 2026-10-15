-- isis_wa_grupos_dia_cuit.sql — Agrupa las facturas del día de un CUIT para el aviso de factura.
--
-- Proyecto: Gestión / ISIS (hrxfctzncixxqmpfhskv). La usa el edge lk_factura-check
-- (handleRealRedirect) para armar el grupo de facturas a enviar por WhatsApp.
--
-- Problema (auditoría github_repo_problemas id 780): el filtro np_cli sólo tomaba NP con
-- fecha_salida entre (p_fecha - 8) y (p_fecha + 1). Un pedido facturado ANTES de salir
-- (retiros/adelantos) o bastante DESPUÉS quedaba fuera, y el bot no mandaba su factura.
-- Quedaba desalineado con el cruce gv_cruce_fc_asignacion v30.42 (Luis, 14/10), que ya
-- soporta facturación independiente de la salida.
--
-- Solución: alinear la ventana de np_cli con la misma lógica del cruce: la NP entra si la
-- factura (p_fecha) cae entre la fecha más temprana y la más tardía de (salida, facturación),
-- con 3 días de margen. docs (fecha = p_fecha) y el cruce 1:1 garantizan que sólo se mande la
-- factura emitida ese día.

-- order_ids: order_id (orders.id de PaginaLK) por factura, alineado con comprobantes. Lo usa la
-- edge para cruzar contra order_tracking.status='entregado' y recién ahí mandar la factura. null si
-- la NP no es web (ISIS directo) — ésas no tienen señal de despacho y el gate las deja pendientes.
drop function if exists public.wa_grupos_dia_cuit(text, date);
create function public.wa_grupos_dia_cuit(p_cuit text, p_fecha date)
 returns table(empresa text, destino text, cod_cliente text, razon_social text, n_facturas integer, comprobantes text[], storage_paths text[], totales numeric[], metodos text[], metodos_fac text[], order_ids bigint[])
 language sql stable security definer set search_path to 'public'
as $function$
  with cods as (
    select distinct contraparte_codigo cod from public.comprobantes_venta
    where contraparte_cuit = p_cuit and contraparte_codigo is not null
  ),
  np_cli as (
    -- v30.42 (Luis, 14/10): la facturación es INDEPENDIENTE de la salida: puede emitirse antes
    -- (retiros/adelantos), el mismo día, o después. Se alinea con gv_cruce_fc_asignacion: la NP
    -- entra si la factura (p_fecha) cae entre la fecha más temprana y la más tardía de
    -- (salida, facturación), con 3 días de margen a cada lado. docs (fecha = p_fecha) y el cruce
    -- 1:1 garantizan que sólo se mande la factura emitida ese día.
    select distinct f.np from public."Facturacion_NP" f
    where f.cod_cliente in (select cod from cods)
      and f.facturado_at is not null
      and p_fecha between least(f.fecha_salida, (f.facturado_at at time zone 'America/Argentina/Buenos_Aires')::date) - 3
                     and greatest(f.fecha_salida, (f.facturado_at at time zone 'America/Argentina/Buenos_Aires')::date) + 3
  ),
  cruce as (
    select c.np, c.comprobante_id, c.storage_path, c.factura_total,
      case when c.np ~* '^ch' or left(btrim(c.np),1)='4' then 'chef' else 'lk' end as empresa
    from public.gv_cruce_facturacion_nps( (select array_agg(np) from np_cli) ) c
    where c.comprobante_id is not null
  ),
  docs as (
    select 'lk'::text empresa, comprobante_id, id doc_id, fecha doc_fecha, condicion_venta
      from isis_lk.documentos where familia='factura_venta' and fecha = p_fecha
    union all
    select 'chef'::text, comprobante_id, id, fecha, condicion_venta
      from isis_ch.documentos where familia='factura_venta' and fecha = p_fecha
  ),
  base as (
    select cr.empresa, cr.np, cr.comprobante_id, cr.storage_path, cr.factura_total, d.condicion_venta cond,
      fn.cod_cliente, wp.order_id,
      coalesce(sn.razon_social, wp.razon_social, pp.razon_social, fn.razon_social) razon_social,
      public.wa_destino_norm(sn.sucursal_entrega, coalesce(sn.direccion, wp.direccion, pp.direccion)) destino
    from cruce cr
    join docs d on d.comprobante_id = cr.comprobante_id and d.empresa = cr.empresa
    left join public."Facturacion_NP" fn on fn.np = cr.np
    left join public.wa_np_snapshot sn on sn.np = cr.np
    left join lateral (
      -- PPP_Web_Programacion guarda la empresa como 'lk'/'chef' (no 'ch'): se empareja con cr.empresa,
      -- que el cruce ya deriva como 'lk'/'chef'. Antes usaba lower(split_part(np,' ',1)) = 'ch' y Chef
      -- nunca matcheaba (perdía order_id y dirección web).
      select w.razon_social, w.direccion, w.order_id from public."PPP_Web_Programacion" w
      where cr.np ~* '^(lk|ch) ' and w.empresa = cr.empresa
        and w.np = nullif(regexp_replace(split_part(cr.np,' ',2),'\D','','g'),'')::int
      limit 1) wp on true
    left join lateral (
      select pp.razon_social, pp.direccion from public."GV_PPP_Programacion_Diaria" pp
      where pp.np = cr.np order by pp.id desc limit 1) pp on true
  )
  select empresa, destino, max(cod_cliente), max(razon_social), count(*)::int,
    array_agg(comprobante_id order by comprobante_id),
    array_agg(storage_path order by comprobante_id),
    array_agg(factura_total order by comprobante_id),
    array_agg(distinct public.wa_metodo_norm(cond)),
    array_agg(public.wa_metodo_norm(cond) order by comprobante_id),
    array_agg(order_id order by comprobante_id)
  from base group by empresa, destino
$function$;
