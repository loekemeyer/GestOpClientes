-- BACKUP (2026-09-09) — definiciones de vista_np_factura y vista_grupo_pedido ANTES de dropearlas.
-- Quedaron huérfanas al migrar el aviso a gv_cruce_facturacion_nps y retirar
-- wa_envio_grupos_dia/_pendientes. Verificado: 0 objetos DB (salvo la dependencia
-- vista_grupo_pedido -> vista_np_factura), 0 cron, 0 lecturas REST en Virgilio/GestOpClientes.
-- Para restaurar: correr este archivo en el SQL editor de ISIS (hrxfctzncixxqmpfhskv), en orden.

create or replace view public.vista_np_factura as
 WITH np AS (
         SELECT f.np,
            f.cod_cliente,
            COALESCE(NULLIF(f.razon_social, ''::text), s.razon_social, p.razon_social) AS razon_social,
            f.fecha_salida,
            f.facturado_at,
                CASE
                    WHEN "left"(f.np, 1) = '4'::text THEN 'chef'::text
                    ELSE 'lk'::text
                END AS empresa,
            COALESCE(s.direccion, NULLIF(btrim(p.direccion), ''::text)) AS direccion,
            COALESCE(s.barrio, NULLIF(btrim(p.barrio), ''::text)) AS barrio,
            COALESCE(s.zona, NULLIF(btrim(p.zona), ''::text)) AS zona,
            s.sucursal_entrega,
            n.neto,
            n.neto_original,
            n.cajas_ent,
            n.cajas_falto
           FROM "Facturacion_NP" f
             LEFT JOIN wa_np_snapshot s ON s.np = f.np
             LEFT JOIN vista_facturacion_neto n ON n.np = f.np
             LEFT JOIN LATERAL ( SELECT pp.razon_social, pp.direccion, pp.barrio, pp.zona
                   FROM "PPP_Programacion_Diaria" pp
                  WHERE pp.np = f.np
                  ORDER BY pp.id DESC
                 LIMIT 1) p ON true
          WHERE f.fecha_salida > (CURRENT_DATE - 5)
        ), pairs AS (
         SELECT np_1.np, d.id AS doc_id, d.comprobante_id, d.fecha AS doc_fecha, d.total AS factura_total,
            d.subt_gravado AS factura_neto, d.total_cajas AS factura_cajas, d.storage_path,
            abs(d.subt_gravado - np_1.neto) AS dneto
           FROM np np_1
             JOIN isis_lk.documentos d ON np_1.empresa = 'lk'::text AND d.familia = 'factura_venta'::text AND d.fecha >= (np_1.fecha_salida - 3) AND d.fecha <= (np_1.fecha_salida + 3) AND abs(COALESCE(d.total_cajas, '-1'::integer::numeric) - np_1.cajas_ent) < 0.5 AND np_1.neto IS NOT NULL AND np_1.neto <> 0::numeric AND abs(d.subt_gravado - np_1.neto) <= (0.05 * np_1.neto)
        UNION ALL
         SELECT np_1.np, d.id, d.comprobante_id, d.fecha, d.total, d.subt_gravado, d.total_cajas, d.storage_path,
            abs(d.subt_gravado - np_1.neto) AS abs
           FROM np np_1
             JOIN isis_ch.documentos d ON np_1.empresa = 'chef'::text AND d.familia = 'factura_venta'::text AND d.fecha >= (np_1.fecha_salida - 3) AND d.fecha <= (np_1.fecha_salida + 3) AND abs(COALESCE(d.total_cajas, '-1'::integer::numeric) - np_1.cajas_ent) < 0.5 AND np_1.neto IS NOT NULL AND np_1.neto <> 0::numeric AND abs(d.subt_gravado - np_1.neto) <= (0.05 * np_1.neto)
        ), cand AS (
         SELECT pairs.np, count(*) AS n_candidatos FROM pairs GROUP BY pairs.np
        ), ranked AS (
         SELECT p.np, p.doc_id, p.comprobante_id, p.doc_fecha, p.factura_total, p.factura_neto,
            p.factura_cajas, p.storage_path, p.dneto,
            row_number() OVER (PARTITION BY p.np ORDER BY p.dneto, p.doc_id) AS rn_np,
            row_number() OVER (PARTITION BY p.doc_id ORDER BY p.dneto, p.np) AS rn_doc
           FROM pairs p
        ), asignado AS (
         SELECT ranked.* FROM ranked WHERE ranked.rn_np = 1 AND ranked.rn_doc = 1
        )
 SELECT np.np, np.empresa, np.cod_cliente, np.razon_social, np.fecha_salida, np.facturado_at,
    np.direccion, np.barrio, np.zona, np.sucursal_entrega, np.neto, np.cajas_ent, np.cajas_falto,
    a.doc_id, a.comprobante_id, a.doc_fecha, a.factura_total, a.factura_neto, a.factura_cajas,
    a.storage_path, COALESCE(c.n_candidatos, 0::bigint) AS n_candidatos,
        CASE
            WHEN a.doc_id IS NULL AND COALESCE(c.n_candidatos, 0::bigint) = 0 THEN 'sin_factura'::text
            WHEN a.doc_id IS NULL THEN 'ambiguo'::text
            WHEN a.dneto <= (0.005 * np.neto) THEN 'exacto'::text
            WHEN a.dneto <= (0.03 * np.neto) THEN 'bueno'::text
            ELSE 'revisar'::text
        END AS match_calidad,
    a.dneto AS delta_neto
   FROM np
     LEFT JOIN asignado a ON a.np = np.np
     LEFT JOIN cand c ON c.np = np.np;

create or replace view public.vista_grupo_pedido as
 SELECT empresa, cod_cliente, max(razon_social) AS razon_social,
    COALESCE(NULLIF(sucursal_entrega, ''::text), NULLIF(upper(btrim(direccion)), ''::text), '(s/dir)'::text) AS destino_key,
    max(direccion) AS direccion, max(sucursal_entrega) AS sucursal_entrega, max(barrio) AS barrio, max(zona) AS zona,
    fecha_salida AS fecha, count(*) AS n_nps, count(doc_id) AS n_matched,
    count(*) FILTER (WHERE match_calidad = ANY (ARRAY['exacto'::text, 'bueno'::text])) AS n_confiable,
    sum(COALESCE(factura_total, 0::numeric)) AS total_facturas,
    bool_and(doc_id IS NOT NULL) AS todas_matcheadas,
    bool_and(match_calidad = ANY (ARRAY['exacto'::text, 'bueno'::text])) AS todas_confiables,
    bool_or(direccion IS NOT NULL OR sucursal_entrega IS NOT NULL) AS tiene_destino,
    array_agg(np ORDER BY np) AS nps,
    array_remove(array_agg(doc_id ORDER BY np), NULL::bigint) AS doc_ids,
    array_remove(array_agg(comprobante_id ORDER BY np), NULL::text) AS comprobantes,
        CASE
            WHEN bool_and(doc_id IS NOT NULL) AND bool_and(match_calidad = ANY (ARRAY['exacto'::text, 'bueno'::text])) THEN 'listo'::text
            WHEN count(doc_id) > 0 THEN 'parcial'::text
            ELSE 'pendiente'::text
        END AS estado_grupo
   FROM vista_np_factura x
  GROUP BY empresa, cod_cliente, (COALESCE(NULLIF(sucursal_entrega, ''::text), NULLIF(upper(btrim(direccion)), ''::text), '(s/dir)'::text)), fecha_salida;
