-- gp_vista_factura_metodo_pago.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- Vincula cada factura PARSEADA con el MÉTODO DE PAGO real que eligió el cliente
-- en el portal web, SIN depender del parser para ese dato.
--
-- Cadena:
--   isis_lk.documentos (PDF parseado)
--     ──CAE──>  Comprobantes_ARCA (se escribe al facturar; trae np + comprobante)
--     ──np──>   vista_np_sucursal  (np -> metodo_pago del portal, vía lk_pedidos_match/PPP)
--
-- Join principal: CAE (código AFIP, único, el parser lo lee del PDF).
-- Respaldo: coordenadas del comprobante (tipo_cbte + pto_vta + nro_cbte),
-- normalizando el padding del parser ("0005"/"00000011") al entero de ARCA.
-- Nota: isis_lk.cod_comprobante (ej '201') == Comprobantes_ARCA.tipo_cbte (AFIP).
--
-- La vista corre con privilegios del owner (postgres), así que alcanza isis_lk
-- aunque ese schema no esté expuesto en PostgREST. Solo expone el join, no la tabla.
--
-- TODO cuando cargue Chef: unir isis_ch.documentos con un UNION ALL (ARCA ya
-- distingue empresa por el número de NP: 9xxxx=lk, 4xxxx=chef).

create or replace view public.vista_factura_metodo_pago as
select
  d.id                as documento_id,
  d.comprobante_id,
  d.familia,
  d.cae,
  d.punto_venta,
  d.numero,
  d.cod_comprobante,
  d.contraparte_cuit,
  d.contraparte_codigo,
  d.fecha,
  d.total,
  d.confianza,
  c.np,
  case
    when c.cae is not null and c.cae = d.cae then 'cae'
    when c.np is not null then 'coordenadas'
    else null
  end                 as match_por,
  vns.metodo_pago,
  vns.sucursal_entrega
from isis_lk.documentos d
left join public."Comprobantes_ARCA" c on (
      (d.cae is not null and c.cae = d.cae)
   or (
        nullif(regexp_replace(coalesce(d.cod_comprobante,''), '\D', '', 'g'), '')::int = c.tipo_cbte
    and nullif(regexp_replace(coalesce(d.punto_venta,''),    '\D', '', 'g'), '')::int = c.pto_vta
    and nullif(regexp_replace(coalesce(d.numero,''),         '\D', '', 'g'), '')::int = c.nro_cbte
      )
)
left join public.vista_np_sucursal vns on vns.np = c.np
where d.familia = 'factura_venta';

grant select on public.vista_factura_metodo_pago to anon, authenticated, service_role;
