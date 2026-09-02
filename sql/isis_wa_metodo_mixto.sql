-- ISIS (hrxfctzncixxqmpfhskv) — Regla método-mixto + reintento robusto. Ya aplicado en ISIS.
--
-- Contexto (regla de negocio, confirmada 2026-09-02):
--   Un "pedido" = grupo del día por cuit + empresa + dirección de entrega (wa_destino_norm).
--   Dentro de ese grupo, si hay varias facturas con métodos de pago MIXTOS:
--     · las facturas con "prefiere no decir" (no_decidido) son agregados de mercadería y
--       se ASUMEN con el mismo método que la(s) otra(s) del grupo → un solo mensaje;
--     · si hay ≥2 métodos REALES distintos (sin contar no_decidido), se manda UN mensaje
--       por método; las no_decidido en ese caso se tratan como CONTADO (se fusionan con el
--       grupo contado si existe, o forman uno nuevo). No hay retención.
--   Para poder mapear factura→método, el RPC ahora devuelve el método POR factura
--   (metodos_fac, alineado con comprobantes/storage_paths/totales por comprobante_id).
--   La lógica de split/absorción vive en lk_factura-check (handleRealRedirect).

-- 1) wa_grupos_dia_cuit: agrega metodos_fac (método por factura, alineado). Se conserva
--    metodos (distinct) por compatibilidad.
drop function if exists public.wa_grupos_dia_cuit(text, date);
create or replace function public.wa_grupos_dia_cuit(p_cuit text, p_fecha date)
returns table(empresa text, destino text, cod_cliente text, razon_social text, n_facturas integer,
              comprobantes text[], storage_paths text[], totales numeric[], metodos text[], metodos_fac text[])
language sql stable security definer set search_path to 'public' as $function$
  with cods as (
    select distinct contraparte_codigo cod from public.comprobantes_venta
    where contraparte_cuit = p_cuit and contraparte_codigo is not null
  ),
  base as (
    select v.np, v.empresa, v.cod_cliente,
      public.wa_destino_norm(v.sucursal_entrega, v.direccion) destino,
      v.razon_social, v.comprobante_id, v.storage_path, v.factura_total, v.doc_id,
      (select d.condicion_venta from isis_lk.documentos d where d.id=v.doc_id and v.empresa='lk'
       union all select d.condicion_venta from isis_ch.documentos d where d.id=v.doc_id and v.empresa='chef' limit 1) cond
    from public.vista_np_factura v
    where v.cod_cliente in (select cod from cods) and v.doc_fecha = p_fecha
      and v.doc_id is not null and v.storage_path is not null
  )
  select empresa, destino, max(cod_cliente), max(razon_social), count(*)::int,
    array_agg(comprobante_id order by comprobante_id),
    array_agg(storage_path order by comprobante_id),
    array_agg(factura_total order by comprobante_id),
    array_agg(distinct public.wa_metodo_norm(cond)),
    array_agg(public.wa_metodo_norm(cond) order by comprobante_id)  -- método por factura (alineado)
  from base group by empresa, destino;
$function$;

-- 2) wa_dashboard_rango: el dedup de facturas_enviadas ahora incluye el método en la clave
--    (con split, un mismo cuit+empresa+destino genera varios avisos, uno por método). La
--    definición vigente vive en isis_wa_dashboard.sql (ya aplicada con ese cambio).

-- 3) Barrido de reintento (wa_barrido_avisos): antes barría solo current_date, así que una
--    factura que caía en el olvido (parser roto, config activada tarde) no se recuperaba tras
--    la medianoche. Ahora barre HOY y AYER (ventana 48h) cada 15 min. lk_factura-check es
--    idempotente (salta lo ya enviado), así que reintentar es barato y seguro.
select cron.unschedule(jobid) from cron.job where jobname='wa_barrido_avisos';
select cron.schedule('wa_barrido_avisos', '*/15 * * * *', $cmd$
  select net.http_post(
    url:='https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:=jsonb_build_object('source',c.source,'cuit',c.cuit,'fecha',to_char(dd.d,'YYYY-MM-DD')))
  from (select current_date as d union all select current_date - 1) dd
  cross join lateral public.wa_cuits_facturados_dia(dd.d) c;
$cmd$);
