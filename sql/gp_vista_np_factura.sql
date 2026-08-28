-- gp_vista_np_factura.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- Sistema FORWARD-FACING de matcheo NP <-> factura (DORMANT: solo lectura, sin envío).
-- Ventana: últimos 5 días (backlog corto; el objetivo es rastrear facturas a medida
-- que salen y matchearlas a la NP que las originó).
--
-- Premisa (owner): cada NP que termina el proceso de la PPP (aparece en Facturacion_NP)
-- eventualmente va a tener su factura. A medida que las facturas se parsean, cada una se
-- ata a su NP por:
--   * CAJAS entregadas (llave inmune a precios): total_cajas (factura) == cajas_ent (NP)
--   * NETO: subt_gravado (factura) ~= neto (NP = SUM(importe_ent)*0.98)
--   * ventana ±3 días alrededor de fecha_salida de la NP
--   * empresa: prefijo del NP  9xxxx -> LK (isis_lk) | 4xxxx -> Chef (isis_ch)
-- Asignación 1:1 mutua (mutual best match) para no atar una misma factura a dos NPs.
--
-- Layer 1 = vista_np_factura   : una fila por NP con su factura asignada (o sin_match) + calidad.
-- Layer 2 = vista_grupo_pedido : agrupa por cliente + DIRECCIÓN de entrega + día.
--   La dirección separa dos pedidos distintos del mismo cliente el mismo día que van a
--   lugares diferentes. estado_grupo='listo' == todas las NPs del grupo facturadas y
--   matcheadas con confianza -> recién ahí el conjunto está completo para enviar (después).

-- ============================================================================
-- Layer 1: NP -> factura
-- ============================================================================
drop view if exists public.vista_grupo_pedido;
drop view if exists public.vista_np_factura;

-- Dirección de entrega: se lee del snapshot persistente wa_np_snapshot (ver
-- gp_wa_np_snapshot.sql) porque PPP_Programacion_Diaria rota a diario. Fallback a la
-- PPP viva para las NPs de hoy que todavía no se snapshotearon.
create view public.vista_np_factura as
with np as (
  select
    f.np,
    f.cod_cliente,
    coalesce(nullif(f.razon_social,''), s.razon_social, p.razon_social) as razon_social,
    f.fecha_salida,
    f.facturado_at,
    case when left(f.np,1)='4' then 'chef' else 'lk' end as empresa,
    coalesce(s.direccion, nullif(btrim(p.direccion),'')) as direccion,
    coalesce(s.barrio,    nullif(btrim(p.barrio),''))    as barrio,
    coalesce(s.zona,      nullif(btrim(p.zona),''))       as zona,
    s.sucursal_entrega,
    n.neto, n.neto_original, n.cajas_ent, n.cajas_falto
  from public."Facturacion_NP" f
  left join public.wa_np_snapshot s on s.np = f.np
  left join public.vista_facturacion_neto n on n.np = f.np
  left join lateral (
    select pp.razon_social, pp.direccion, pp.barrio, pp.zona
    from public."PPP_Programacion_Diaria" pp
    where pp.np = f.np
    order by pp.id desc
    limit 1
  ) p on true
  where f.fecha_salida > current_date - 5
),
-- Pares candidatos (cajas exactas + neto ±5% + ventana + empresa correcta).
pairs as (
  select np.np, d.id as doc_id, d.comprobante_id, d.fecha as doc_fecha,
         d.total as factura_total, d.subt_gravado as factura_neto,
         d.total_cajas as factura_cajas, d.storage_path,
         abs(d.subt_gravado - np.neto) as dneto
  from np
  join isis_lk.documentos d
    on np.empresa = 'lk'
   and d.familia = 'factura_venta'
   and d.fecha between np.fecha_salida - 3 and np.fecha_salida + 3
   and abs(coalesce(d.total_cajas, -1) - np.cajas_ent) < 0.5
   and np.neto is not null and np.neto <> 0
   and abs(d.subt_gravado - np.neto) <= 0.05 * np.neto
  union all
  select np.np, d.id, d.comprobante_id, d.fecha,
         d.total, d.subt_gravado, d.total_cajas, d.storage_path,
         abs(d.subt_gravado - np.neto)
  from np
  join isis_ch.documentos d
    on np.empresa = 'chef'
   and d.familia = 'factura_venta'
   and d.fecha between np.fecha_salida - 3 and np.fecha_salida + 3
   and abs(coalesce(d.total_cajas, -1) - np.cajas_ent) < 0.5
   and np.neto is not null and np.neto <> 0
   and abs(d.subt_gravado - np.neto) <= 0.05 * np.neto
),
cand as (  -- cuántos candidatos tiene cada NP (para distinguir "ambiguo" de "sin factura")
  select np, count(*) as n_candidatos from pairs group by np
),
ranked as (
  select p.*,
    row_number() over (partition by p.np     order by p.dneto, p.doc_id) as rn_np,
    row_number() over (partition by p.doc_id order by p.dneto, p.np)     as rn_doc
  from pairs p
),
asignado as (  -- mutual best match: mejor NP para la factura Y mejor factura para la NP
  select * from ranked where rn_np = 1 and rn_doc = 1
)
select
  np.np,
  np.empresa,
  np.cod_cliente,
  np.razon_social,
  np.fecha_salida,
  np.facturado_at,
  np.direccion,
  np.barrio,
  np.zona,
  np.sucursal_entrega,
  np.neto,
  np.cajas_ent,
  np.cajas_falto,
  a.doc_id,
  a.comprobante_id,
  a.doc_fecha,
  a.factura_total,
  a.factura_neto,
  a.factura_cajas,
  a.storage_path,
  coalesce(c.n_candidatos, 0) as n_candidatos,
  case
    when a.doc_id is null and coalesce(c.n_candidatos,0) = 0 then 'sin_factura'   -- no hay factura parseada todavía
    when a.doc_id is null                                    then 'ambiguo'        -- había candidato pero lo tomó otra NP
    when a.dneto <= 0.005 * np.neto                          then 'exacto'         -- cajas + neto (≤0.5%)
    when a.dneto <= 0.03  * np.neto                          then 'bueno'          -- cajas + neto (≤3%)
    else 'revisar'                                                                 -- cajas ok, neto flojo (faltante/split?)
  end as match_calidad,
  a.dneto as delta_neto
from np
left join asignado a on a.np = np.np
left join cand     c on c.np = np.np;

grant select on public.vista_np_factura to anon, authenticated, service_role;

-- ============================================================================
-- Layer 2: grupo de pedido = cliente + dirección de entrega + día
-- ============================================================================
-- Clave de destino: sucursal_entrega si existe, si no la dirección normalizada. Esto
-- separa dos pedidos del mismo cliente el mismo día que van a lugares distintos.
create view public.vista_grupo_pedido as
select
  x.empresa,
  x.cod_cliente,
  max(x.razon_social)                                   as razon_social,
  coalesce(nullif(x.sucursal_entrega,''), nullif(upper(btrim(x.direccion)),''), '(s/dir)') as destino_key,
  max(x.direccion)                                      as direccion,
  max(x.sucursal_entrega)                               as sucursal_entrega,
  max(x.barrio)                                         as barrio,
  max(x.zona)                                           as zona,
  x.fecha_salida                                        as fecha,
  count(*)                                              as n_nps,
  count(x.doc_id)                                       as n_matched,
  count(*) filter (where x.match_calidad in ('exacto','bueno')) as n_confiable,
  sum(coalesce(x.factura_total, 0))                     as total_facturas,
  bool_and(x.doc_id is not null)                        as todas_matcheadas,
  bool_and(x.match_calidad in ('exacto','bueno'))       as todas_confiables,
  bool_or(x.direccion is not null or x.sucursal_entrega is not null) as tiene_destino,
  array_agg(x.np order by x.np)                         as nps,
  array_remove(array_agg(x.doc_id order by x.np), null)         as doc_ids,
  array_remove(array_agg(x.comprobante_id order by x.np), null) as comprobantes,
  case
    when bool_and(x.doc_id is not null)
     and bool_and(x.match_calidad in ('exacto','bueno')) then 'listo'      -- completo -> listo para enviar
    when count(x.doc_id) > 0                              then 'parcial'    -- algunas facturas ya matchearon
    else 'pendiente'                                                        -- ninguna todavía
  end as estado_grupo
from public.vista_np_factura x
group by
  x.empresa,
  x.cod_cliente,
  coalesce(nullif(x.sucursal_entrega,''), nullif(upper(btrim(x.direccion)),''), '(s/dir)'),
  x.fecha_salida;

grant select on public.vista_grupo_pedido to anon, authenticated, service_role;
