-- 154 · bot_mis_descuentos: gate por escala_activa (Pablo Olejavetzky, 14/10/2026)
--
-- Contexto: la RPC devolvía la escala de descuentos por forma de pago HARDCODEADA e idéntica para
-- todo cliente (0,25 / 0,20 / 0,15 / 0,10 / 0,05). Verificado contra la página (pagina-LK-copia,
-- script.js): los 6 chips de método de pago son los mismos para todo cliente mayorista estándar y el
-- descuento sale del método que elige en el checkout; `payment_term` es un código del ERP (null en
-- ~598 de 1.260 clientes) y la página NUNCA lo usa para recortar la escala. El ÚNICO filtro por
-- cliente que hace la página es `escala_activa`: ese cliente va obligado a Contado -25%
-- (getPaymentDiscount, script.js ~2827: `if (_expoClientMode || _escalaActiva) return 0.25`).
--
-- Cambio: para un cliente con `customers.escala_activa = true`, los plazos distintos de contado
-- vuelven NULL (sólo aplica Contado -25%), espejando a la página. Para el resto, la escala completa
-- como hasta ahora. Misma firma (sin DROP). Al 14/10 hay 2 clientes con escala activa (Autoservicio
-- Capo SA 4286 y MIA REGALOS); ninguno del piloto (Thomy 4028 y Damián/Chef 411 son escala_activa=false).
--
-- El handler TS (consultar_mis_descuentos en _shared/bot-conversation.ts) agrega una nota cuando los
-- plazos vienen null, para que el agente no ofrezca plazos que ese cliente no tiene.
--
-- Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicado (es la definición viva).

CREATE OR REPLACE FUNCTION public.bot_mis_descuentos(p_telefono text)
 RETURNS TABLE(dto_vol numeric, dto_web numeric, pago_contado numeric, pago_15_30 numeric,
   pago_30_45 numeric, pago_45_60 numeric, pago_90_echeq numeric, business_name text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_web numeric;
BEGIN
  SELECT s.value INTO v_web FROM public.app_settings s WHERE s.key = 'web_order_discount';
  RETURN QUERY
  SELECT
    cc.dto_vol,
    COALESCE(v_web, 0.02),
    0.25::numeric,
    CASE WHEN c.escala_activa THEN NULL ELSE 0.20 END::numeric,
    CASE WHEN c.escala_activa THEN NULL ELSE 0.15 END::numeric,
    CASE WHEN c.escala_activa THEN NULL ELSE 0.10 END::numeric,
    CASE WHEN c.escala_activa THEN NULL ELSE 0.05 END::numeric,
    cc.business_name
  FROM public.bot_cliente_por_whatsapp(p_telefono) cc
  JOIN public.customers c ON c.id = cc.customer_id;
END;
$function$;
