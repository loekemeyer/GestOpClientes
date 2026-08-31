-- ISIS (hrxfctzncixxqmpfhskv) — Envío REAL de avisos de facturación (grupos reales linkeados).
-- Ya aplicado en ISIS. Usa el linkeo NP↔factura del viernes (vista_np_factura).
--
-- wa_envio_grupos_pendientes(): arma los grupos reales COMPLETOS (todas las NPs del grupo
-- cod|destino|día con su factura+PDF matcheado) listos para enviar. Lo consume el driver
-- lk_notif-sim (acción real_sweep), que llama a lk_factura-check en modo 'grupo'.
-- El envío real va SÓLO al número de redirección (app_settings.wa_real_redirect_to) y sólo
-- el día app_settings.wa_real_redirect_date (evento acotado). Nunca al cliente.

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
