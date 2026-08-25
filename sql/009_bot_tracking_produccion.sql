-- RPC: bot_tracking_produccion — estado de pedidos en flujo de producción (PPP)
-- Deriva el estado de cada pedido cruzando ppp_programacion, ppp_etapa,
-- ppp_facturacion y ppp_entregados.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
--
-- Estados para el cliente (simplificados):
--   recibido    → pedido registrado, sin programación aún
--   programado  → asignado a tanda de producción
--   preparando  → en picking o armado (el cliente no distingue)
--   preparado   → armado terminado o cargado en camión
--   en camino   → facturado y despachado
--   entregado   → confirmado entregado

CREATE OR REPLACE FUNCTION bot_tracking_produccion(
  p_telefono text,
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  np text,
  fecha_pedido text,
  fecha_entrega_prog text,
  estado text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cod text;
BEGIN
  -- Buscar cod_cliente del teléfono
  SELECT cw.cod_cliente::text INTO v_cod
  FROM bot_customer_whatsapps cw
  WHERE regexp_replace(COALESCE(cw.whatsapp,''), '[^0-9]', '', 'g')
      = regexp_replace(COALESCE(p_telefono,''), '[^0-9]', '', 'g')
    AND regexp_replace(COALESCE(p_telefono,''), '[^0-9]', '', 'g') <> ''
  ORDER BY cw.is_primary DESC, cw.created_at DESC
  LIMIT 1;

  IF v_cod IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH pedidos AS (
    SELECT
      prog.np,
      prog.fecha_recep,
      prog.fecha_entrega,
      prog.tanda,
      COALESCE(etapa.picking_ini, false) AS picking_ini,
      COALESCE(etapa.armado_fin, false) AS armado_fin,
      COALESCE(etapa.carga, false) AS carga_flag,
      EXISTS (SELECT 1 FROM ppp_facturacion f WHERE f.np = prog.np) AS facturado,
      EXISTS (SELECT 1 FROM ppp_entregados e WHERE e.tanda = prog.tanda AND prog.tanda <> '') AS entregado_flag
    FROM ppp_programacion prog
    LEFT JOIN ppp_etapa etapa ON etapa.tanda = prog.tanda AND prog.tanda <> ''
    WHERE prog.cod = v_cod
  )
  SELECT
    p.np,
    CASE WHEN p.fecha_recep IS NOT NULL AND p.fecha_recep <> ''
         THEN TO_CHAR(p.fecha_recep::date, 'DD/MM/YYYY')
         ELSE NULL END,
    CASE WHEN p.fecha_entrega IS NOT NULL AND p.fecha_entrega <> ''
         THEN TO_CHAR(p.fecha_entrega::date, 'DD/MM/YYYY')
         ELSE NULL END,
    CASE
      WHEN p.entregado_flag THEN 'entregado'
      WHEN p.facturado      THEN 'en camino'
      WHEN p.carga_flag     THEN 'preparado'
      WHEN p.armado_fin     THEN 'preparado'
      WHEN p.picking_ini    THEN 'preparando'
      WHEN p.tanda IS NOT NULL AND p.tanda <> '' THEN 'programado'
      ELSE 'recibido'
    END
  FROM pedidos p
  -- Activos primero (en camino, preparando/preparado), luego programados/recibidos, entregados al final
  ORDER BY
    CASE
      WHEN p.entregado_flag THEN 5
      WHEN p.facturado      THEN 1
      WHEN p.carga_flag OR p.armado_fin THEN 2
      WHEN p.picking_ini    THEN 2
      WHEN p.tanda IS NOT NULL AND p.tanda <> '' THEN 3
      ELSE 4
    END,
    p.fecha_entrega ASC NULLS LAST
  LIMIT p_limit;
END;
$$;
