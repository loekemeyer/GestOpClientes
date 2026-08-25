-- RPC para que el bot WhatsApp pueda enviar pedidos
-- submit_order_fast requiere auth.uid() (diseñado para usuarios web)
-- Esta RPC es para service_role (Edge Function), sin auth context.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

CREATE OR REPLACE FUNCTION bot_submit_order(
  p_telefono    text,
  p_items       jsonb,          -- [{product_id, cajas, uxb, is_loke}]
  p_payment_method text DEFAULT 'transferencia'
)
RETURNS TABLE(order_id bigint, total numeric, items_count int)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_customer_id   uuid;
  v_cod_cliente   bigint;
  v_dto_vol       numeric;
  v_web_discount  numeric;
  v_subtotal      numeric := 0;
  v_total         numeric := 0;
  v_payment_disc  numeric := 0;
  v_order_id      bigint;
  v_items_count   int;
  v_item          jsonb;
  v_price         numeric;
  v_uxb           int;
BEGIN
  -- 1. Verificar cliente por teléfono
  SELECT cc.customer_id, cc.cod_cliente, cc.dto_vol
    INTO v_customer_id, v_cod_cliente, v_dto_vol
  FROM public.bot_cliente_por_whatsapp(p_telefono) cc;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Cliente no identificado para teléfono %', p_telefono;
  END IF;

  -- 2. Obtener descuento web
  SELECT COALESCE(s.value, 0.02) INTO v_web_discount
  FROM public.app_settings s
  WHERE s.key = 'web_order_discount';

  IF v_web_discount IS NULL THEN v_web_discount := 0.02; END IF;

  -- 3. Descuento por método de pago
  IF p_payment_method IN ('transferencia', 'debito') THEN
    v_payment_disc := 0.02;
  END IF;

  -- 4. Calcular subtotal desde items
  v_items_count := jsonb_array_length(p_items);
  IF v_items_count = 0 THEN
    RAISE EXCEPTION 'El pedido debe tener al menos un item';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE((v_item->>'is_loke')::boolean, false) THEN
      SELECT lp.list_price, lp.uxb INTO v_price, v_uxb
      FROM public.loke_products lp
      WHERE lp.id = (v_item->>'product_id')::uuid AND lp.active = true;
    ELSE
      SELECT p.list_price, p.uxb INTO v_price, v_uxb
      FROM public.products p
      WHERE p.id = (v_item->>'product_id')::uuid AND p.active = true;
    END IF;

    IF v_price IS NULL THEN
      RAISE EXCEPTION 'Producto no encontrado: %', v_item->>'product_id';
    END IF;

    v_subtotal := v_subtotal + (v_price * (v_item->>'cajas')::int * COALESCE((v_item->>'uxb')::int, v_uxb));
  END LOOP;

  -- 5. Calcular total con descuentos
  v_total := v_subtotal * (1 - COALESCE(v_dto_vol, 0)) * (1 - v_payment_disc) * (1 - v_web_discount);

  -- 6. Insertar orden (sin auth_user_id, es pedido del bot)
  INSERT INTO public.orders (
    customer_id, status, payment_method,
    payment_discount, web_discount, extra_discount,
    subtotal, total
  ) VALUES (
    v_customer_id, 'pending', p_payment_method,
    v_payment_disc, v_web_discount, COALESCE(v_dto_vol, 0),
    ROUND(v_subtotal, 2), ROUND(v_total, 2)
  ) RETURNING id INTO v_order_id;

  -- 7. Insertar items regulares
  INSERT INTO public.order_items (order_id, product_id, cajas, uxb, is_loke, source)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    COALESCE((item->>'uxb')::int, (
      SELECT p.uxb FROM public.products p WHERE p.id = (item->>'product_id')::uuid
    )),
    false,
    'whatsapp-bot'
  FROM jsonb_array_elements(p_items) AS item
  WHERE COALESCE((item->>'is_loke')::boolean, false) = false;

  -- 8. Insertar items Loke
  INSERT INTO public.order_items (order_id, loke_product_id, cajas, uxb, is_loke, source)
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'cajas')::int,
    COALESCE((item->>'uxb')::int, (
      SELECT lp.uxb FROM public.loke_products lp WHERE lp.id = (item->>'product_id')::uuid
    )),
    true,
    'whatsapp-bot'
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'is_loke')::boolean = true;

  -- 9. Devolver resultado
  order_id := v_order_id;
  total := ROUND(v_total, 2);
  items_count := v_items_count;
  RETURN NEXT;
END;
$$;
