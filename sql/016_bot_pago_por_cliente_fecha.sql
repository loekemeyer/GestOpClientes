-- Resolver del método de pago elegido para un pedido de PRODUCCIÓN (NP de Virgilio).
-- Los NP de Virgilio NO comparten numeración con orders de LK, pero los pedidos entran por la
-- web de LK (tabla orders, con payment_method + payment_discount). Se cruza por
-- customer_code (= cod_cliente) + fecha: el pedido más reciente de ese cliente con fecha <= la
-- fecha de referencia (el pedido se carga ANTES de que salga de producción).
-- Interpreta el plazo (días) y si es e-check a partir del descuento + el texto del método.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg).
--
-- Descuentos por plazo (regla del dueño):
--   contado ≤14 días → 25% · ≤30 → 20% · ≤45 → 15% · ≤60 → 10% ·
--   e-check 90 días → 5% · e-check 120 días → 0%.

CREATE OR REPLACE FUNCTION public.bot_pago_por_cliente_fecha(p_cod_cliente text, p_fecha date)
RETURNS TABLE(
  order_id         bigint,
  fecha_pedido     date,
  payment_method   text,
  payment_discount numeric,
  es_echeq         boolean,
  dias_plazo       integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id,
         o.created_at::date,
         o.payment_method,
         o.payment_discount,
         (o.payment_method ~* 'echeq|e-?check') AS es_echeq,
         CASE round(coalesce(o.payment_discount,0)::numeric, 2)
           WHEN 0.25 THEN 14
           WHEN 0.20 THEN 30
           WHEN 0.15 THEN 45
           WHEN 0.10 THEN 60
           WHEN 0.05 THEN 90
           WHEN 0.00 THEN CASE WHEN o.payment_method ~* 'echeq|e-?check|120' THEN 120 ELSE NULL END
           ELSE NULL
         END AS dias_plazo
  FROM orders o
  WHERE o.customer_code = p_cod_cliente
    AND o.created_at::date <= p_fecha
  ORDER BY o.created_at DESC
  LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.bot_pago_por_cliente_fecha(text, date) TO service_role, authenticated;
