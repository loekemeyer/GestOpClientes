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
-- wa_envio_grupos_pendientes(): (legacy) grupos reales completos por el linkeo NP↔factura
--   (vista_np_factura, por neto). Se conserva como referencia; el flujo vigente es por día.

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

create or replace function public.wa_envio_grupos_pendientes()
returns table(group_key text, empresa text, cod_cliente text, destino text, dia date, razon_social text,
  n_facturas int, comprobantes text[], storage_paths text[], totales numeric[], metodos text[])
language sql security definer set search_path to 'public' as $$
  with base as (
    select v.np, v.empresa, v.cod_cliente,
      public.wa_destino_norm(v.sucursal_entrega,v.direccion) as destino,
      v.fecha_salida::date as dia, v.razon_social, v.comprobante_id, v.storage_path, v.factura_total, v.doc_id,
      (select d.condicion_venta from isis_lk.documentos d where d.id=v.doc_id and v.empresa='lk'
       union all select d.condicion_venta from isis_ch.documentos d where d.id=v.doc_id and v.empresa='chef' limit 1) as cond
    from public.vista_np_factura v
    where v.cod_cliente <> '99999'
  )
  select empresa||'|'||cod_cliente||'|'||destino||'|'||dia::text,
    empresa, cod_cliente, destino, dia, max(razon_social),
    count(*)::int,
    array_agg(comprobante_id order by comprobante_id),
    array_agg(storage_path order by comprobante_id),
    array_agg(factura_total order by comprobante_id),
    array_agg(distinct public.wa_metodo_norm(cond))
  from base
  group by empresa, cod_cliente, destino, dia
  having bool_and(doc_id is not null) and bool_and(storage_path is not null);
$$;
