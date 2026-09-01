-- 047_wa_conversaciones_list_business_name.sql
-- Amplía wa_conversaciones_list para exponer business_name y cod_cliente
-- del cliente identificado (si existe). Usa la RPC wa_identify_customer
-- vía LATERAL join → aprovecha la normalización de teléfonos que ya
-- vive en esa función. Idempotente.

DROP FUNCTION IF EXISTS public.wa_conversaciones_list();

CREATE OR REPLACE FUNCTION public.wa_conversaciones_list()
RETURNS TABLE (
  phone            text,
  business_name    text,
  cod_cliente      text,
  last_body        text,
  last_rol         text,
  last_at          timestamptz,
  total            bigint,
  inbound_last_at  timestamptz,
  modo             text,
  agente           text,
  modo_expira_en   timestamptz,
  estado           text,
  unread           bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH agg AS (
    SELECT telefono AS phone,
           max(creado_en) AS last_at,
           count(*)::bigint AS total,
           max(creado_en) FILTER (WHERE rol = 'user') AS inbound_last_at
    FROM public.bot_historial_chat
    GROUP BY telefono
  )
  SELECT
    a.phone,
    ident.customer_name,
    ident.cod_cliente,
    (SELECT contenido FROM public.bot_historial_chat h
      WHERE h.telefono = a.phone ORDER BY creado_en DESC LIMIT 1),
    (SELECT rol FROM public.bot_historial_chat h
      WHERE h.telefono = a.phone ORDER BY creado_en DESC LIMIT 1),
    a.last_at,
    a.total,
    a.inbound_last_at,
    COALESCE(bc.modo, 'bot'),
    bc.agente_nombre,
    bc.modo_expira_en,
    COALESCE(hc.estado, 'abierto'),
    (SELECT count(*)::bigint FROM public.bot_historial_chat h
      WHERE h.telefono = a.phone AND h.rol = 'user'
        AND (hc.last_read_at IS NULL OR h.creado_en > hc.last_read_at))
  FROM agg a
  LEFT JOIN LATERAL (
    SELECT customer_name, cod_cliente
    FROM public.wa_identify_customer(a.phone)
    LIMIT 1
  ) ident ON true
  LEFT JOIN public.bot_conversaciones bc ON bc.telefono = a.phone
  LEFT JOIN public.wa_human_control   hc ON hc.phone    = a.phone
  ORDER BY a.last_at DESC;
$$;

COMMENT ON FUNCTION public.wa_conversaciones_list() IS
  'Lista de conversaciones para el módulo de dashboard. Enriquece cada teléfono con business_name/cod_cliente vía wa_identify_customer cuando hay match; deja NULL si no.';
