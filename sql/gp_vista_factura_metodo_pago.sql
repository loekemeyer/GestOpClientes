-- gp_vista_factura_metodo_pago.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- Vincula cada factura PARSEADA con el MÉTODO DE PAGO del cliente.
--
-- Fuente PRIMARIA del método: el propio campo condicion_venta de la factura
-- (los pedidos del cotizador web llegan con la etiqueta elegida por el cliente:
-- "Pago Contado -25%", "Prefiero no decidir ahora", "Pago E-Cheq 90 dias -5%", ...).
-- Se normaliza a 7 categorías con wa_metodo_norm(); lo que no matchea un método
-- claro (Sin Cotizador, legacy "N FF", IMPORTADOR, null) cae en 'no_decidido'.
--
-- Cross-check OPCIONAL (portal, cuando linkea): factura --CAE--> Comprobantes_ARCA
-- (np) --np--> vista_np_sucursal (metodo_pago del portal). Requiere Comprobantes_ARCA
-- poblado; hoy casi vacío, así que metodo_portal suele venir null.

-- ── Normalizador: condicion_venta / metodo_pago  ->  1 de los 7 métodos ──
create or replace function public.wa_metodo_norm(p_cond text)
returns text
language sql
immutable
as $$
  select case
    when p_cond is null then 'no_decidido'
    when p_cond ~* 'contado'                        then 'contado'
    when p_cond ~* 'e[- ]?cheq' and p_cond ~ '120'  then 'echeq_120'
    when p_cond ~* 'e[- ]?cheq' and p_cond ~ '90'   then 'echeq_90'
    when p_cond ~ '46' and p_cond ~ '60'            then 'credito_46_60'
    when p_cond ~ '31' and p_cond ~ '45'            then 'credito_31_45'
    when p_cond ~ '15' and p_cond ~ '30'            then 'credito_15_30'
    else 'no_decidido'
  end;
$$;
-- categorías -> descuento:
--   contado 0.25 | credito_15_30 0.20 | credito_31_45 0.15 | credito_46_60 0.10
--   echeq_90 0.05 | echeq_120 0.00 | no_decidido (sin dto / mostrar escala completa)

grant execute on function public.wa_metodo_norm(text) to anon, authenticated, service_role;

-- ── Vista de vínculo factura -> método (+ np/portal como cross-check) ──
drop view if exists public.vista_factura_metodo_pago;

create view public.vista_factura_metodo_pago as
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
  d.condicion_venta,
  public.wa_metodo_norm(d.condicion_venta)  as metodo_cliente,     -- PRIMARIO (desde la factura)
  c.np,
  case
    when c.cae is not null and c.cae = d.cae then 'cae'
    when c.np is not null then 'coordenadas'
    else null
  end                 as match_por,
  vns.metodo_pago                            as metodo_portal,      -- cross-check (si linkea)
  public.wa_metodo_norm(vns.metodo_pago)     as metodo_portal_norm,
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
