-- ISIS (hrxfctzncixxqmpfhskv) — Envío REAL de avisos de facturación. Ya aplicado en ISIS.
--
-- Modelo vigente (event-driven, anclado al DÍA):
--   Cada factura real que impacta (isis_*.documentos) dispara el trigger wa_factura_notificar,
--   que llama a lk_factura-check {source,cuit,fecha}. lk_factura-check.handleRealRedirect agrupa
--   TODAS las facturas del día de ese cuit (wa_factura_grupo), combina los PDFs reales y entrega
--   SÓLO al número de redirección (app_settings.wa_real_redirect_to) y sólo el día
--   app_settings.wa_real_redirect_date (evento acotado). Nunca al cliente. Idempotente por
--   (cuit, día) en wa_shadow_log. Ancla = día del armado ≈ día de la factura (mismo día, ~96%).
--
-- wa_cuits_facturados_dia(fecha): enumera los cuits reales con factura ese día. Lo usa el
--   driver lk_notif-sim (acción real_sweep) para "flushear" el backlog del día disparando el
--   mismo camino real por cada cuit.
--
-- (2026-09-09) Se retiraron las funciones legacy wa_envio_grupos_dia(date) y
--   wa_envio_grupos_pendientes() — linkeaban por la vieja vista_np_factura y no las usaba
--   nadie (0 crons, 0 dependencias, 0 llamadas). El camino vigente es wa_grupos_dia_cuit.

create or replace function public.wa_cuits_facturados_dia(p_fecha date)
returns table(source text, cuit text) language sql security definer set search_path to 'public' as $$
  select 'lk'::text, contraparte_cuit from isis_lk.documentos
    where familia='factura_venta' and fecha=p_fecha and contraparte_cuit is not null and contraparte_cuit not like '30999%'
    group by contraparte_cuit
  union
  select 'ch'::text, contraparte_cuit from isis_ch.documentos
    where familia='factura_venta' and fecha=p_fecha and contraparte_cuit is not null and contraparte_cuit not like '30999%'
    group by contraparte_cuit;
$$;

-- Agrupa las facturas del día de un cliente (cuit) por EMPRESA + DIRECCIÓN (una entrega por
-- grupo). Regla: LK y CH NUNCA van juntas; un cliente puede tener pedidos a distintas
-- direcciones el mismo día (cada dirección = un mensaje). Lo consume lk_factura-check.handleRealRedirect.
--
-- LINKEO NP↔factura: usa el CRUCE de Gestión `gv_cruce_facturacion_nps` (asignación 1:1),
-- NO la vieja `vista_np_factura`. Motivo (2026-09-09): la vista exigía neto≠0 dentro del 5%
-- y fallaba en dos casos frecuentes — NP con valorización rota (neto=0, ej. 98650) y NP web
-- cuyo neto es un estimado sin el descuento por pago (ej. LK 0011, 8,7% > 5%). El cruce de
-- Gestión asigna por cajas aunque el neto discrepe y reconcilia el neto web. Además la
-- dirección/razón de las NP WEB sale de PPP_Web_Programacion (la vista sólo miraba ISIS).
-- Contrato de salida: 10 cols. `metodos` = set distinto; `metodos_fac` = alineado por
-- comprobante (lo que indexa handleRealRedirect por factura). Sólo LEE objetos de Gestión.
drop function if exists public.wa_grupos_dia_cuit(text, date);
create function public.wa_grupos_dia_cuit(p_cuit text, p_fecha date)
returns table(empresa text, destino text, cod_cliente text, razon_social text, n_facturas int,
  comprobantes text[], storage_paths text[], totales numeric[], metodos text[], metodos_fac text[])
language sql stable security definer set search_path to 'public' as $$
  with cods as (
    select distinct contraparte_codigo cod from public.comprobantes_venta
    where contraparte_cuit = p_cuit and contraparte_codigo is not null
  ),
  np_cli as (  -- NP del cliente con salida en una ventana alrededor del día
    select distinct f.np from public."Facturacion_NP" f
    where f.cod_cliente in (select cod from cods)
      and f.fecha_salida > (p_fecha - 8) and f.fecha_salida <= (p_fecha + 1)
  ),
  cruce as (   -- cruce factura↔NP de Gestión (1:1); empresa derivada de la NP
    select c.np, c.comprobante_id, c.storage_path, c.factura_total,
      case when c.np ~* '^ch' or left(btrim(c.np),1)='4' then 'chef' else 'lk' end as empresa
    from public.gv_cruce_facturacion_nps( (select array_agg(np) from np_cli) ) c
    where c.comprobante_id is not null
  ),
  docs as (    -- facturas del día (las dos empresas) para condición + filtro por fecha
    select 'lk'::text empresa, comprobante_id, id doc_id, fecha doc_fecha, condicion_venta
      from isis_lk.documentos where familia='factura_venta' and fecha = p_fecha
    union all
    select 'chef'::text, comprobante_id, id, fecha, condicion_venta
      from isis_ch.documentos where familia='factura_venta' and fecha = p_fecha
  ),
  base as (
    select cr.empresa, cr.np, cr.comprobante_id, cr.storage_path, cr.factura_total, d.condicion_venta cond,
      fn.cod_cliente,
      coalesce(sn.razon_social, wp.razon_social, pp.razon_social, fn.razon_social) razon_social,
      public.wa_destino_norm(sn.sucursal_entrega, coalesce(sn.direccion, wp.direccion, pp.direccion)) destino
    from cruce cr
    join docs d on d.comprobante_id = cr.comprobante_id and d.empresa = cr.empresa
    left join public."Facturacion_NP" fn on fn.np = cr.np
    left join public.wa_np_snapshot sn on sn.np = cr.np
    left join lateral (  -- NP web → dirección/razón de PPP_Web_Programacion
      select w.razon_social, w.direccion from public."PPP_Web_Programacion" w
      where cr.np ~* '^(lk|ch) ' and w.empresa = lower(split_part(cr.np,' ',1))
        and w.np = nullif(regexp_replace(split_part(cr.np,' ',2),'\D','','g'),'')::int
      limit 1) wp on true
    left join lateral (  -- NP ISIS → dirección/razón de PPP_Programacion_Diaria
      select pp.razon_social, pp.direccion from public."PPP_Programacion_Diaria" pp
      where pp.np = cr.np order by pp.id desc limit 1) pp on true
  )
  select empresa, destino, max(cod_cliente), max(razon_social), count(*)::int,
    array_agg(comprobante_id order by comprobante_id),
    array_agg(storage_path order by comprobante_id),
    array_agg(factura_total order by comprobante_id),
    array_agg(distinct public.wa_metodo_norm(cond)),
    array_agg(public.wa_metodo_norm(cond) order by comprobante_id)
  from base group by empresa, destino;
$$;
