-- RPC para que el bot WhatsApp pueda enviar pedidos
-- submit_order_fast requiere auth.uid() — no sirve para Edge Functions con service_role.
-- Esta RPC acepta códigos de producto (no UUIDs) y resuelve todo internamente.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- UUID sentinel para pedidos del bot (sin FK, no necesita existir en auth.users)
-- '00000000-0000-0000-0000-000000000001'

CREATE OR REPLACE FUNCTION bot_submit_order(
  p_telefono       text,
  p_items          jsonb,     -- [{cod: "505", cajas: 2}, {cod: "506", cajas: 1}]
  p_payment_method text DEFAULT 'transferencia'
)
RETURNS TABLE(order_id bigint, subtotal numeric, total numeric, items_count int)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_bot_uid       uuid := '00000000-0000-0000-0000-000000000001';
  v_customer_id   uuid;
  v_cod_cliente   bigint;
  v_dto_vol       numeric;
  v_web_discount  numeric;
  v_payment_disc  numeric := 0;
  v_subtotal      numeric := 0;
  v_total         numeric := 0;
  v_order_id      bigint;
  v_items_count   int;
  v_item          jsonb;
  v_cod           text;
  v_cajas         int;
  v_product_id    uuid;
  v_loke_id       uuid;
  v_is_loke       boolean;
  v_price         numeric;
  v_uxb           int;
  v_line_total    numeric;
BEGIN
  -- 1. Verificar cliente
  SELECT cc.customer_id, cc.cod_cliente, cc.dto_vol
    INTO v_customer_id, v_cod_cliente, v_dto_vol
  FROM public.bot_cliente_por_whatsapp(p_telefono) cc;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Cliente no identificado para teléfono %', p_telefono;
  END IF;

  -- 2. Validar items
  v_items_count := jsonb_array_length(COALESCE(p_items, '[]'::jsonb));
  IF v_items_count = 0 THEN
    RAISE EXCEPTION 'El pedido debe tener al menos un item';
  END IF;

  -- 3. Descuentos
  SELECT COALESCE(s.value, 0.02) INTO v_web_discount
  FROM public.app_settings s WHERE s.key = 'web_order_discount';
  v_web_discount := COALESCE(v_web_discount, 0.02);

  IF p_payment_method IN ('transferencia', 'debito') THEN
    v_payment_disc := 0.02;
  END IF;

  -- 4. Crear tabla temporal con items resueltos
  CREATE TEMP TABLE _bot_order_items (
    cod text, cajas int, product_id uuid, loke_product_id uuid,
    is_loke boolean, uxb int, list_price numeric, line_total numeric
  ) ON COMMIT DROP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_cod   := v_item->>'cod';
    v_cajas := COALESCE((v_item->>'cajas')::int, 0);

    IF v_cod IS NULL OR v_cajas <= 0 THEN
      RAISE EXCEPTION 'Item inválido: cod=%, cajas=%', v_cod, v_cajas;
    END IF;

    -- Buscar en products primero
    v_product_id := NULL; v_loke_id := NULL; v_is_loke := false;

    SELECT p.id, p.list_price, p.uxb INTO v_product_id, v_price, v_uxb
    FROM public.products p
    WHERE p.cod = v_cod AND p.active = true
    LIMIT 1;

    -- Si no está en products, buscar en loke_products
    IF v_product_id IS NULL THEN
      SELECT lp.id, lp.list_price, lp.uxb INTO v_loke_id, v_price, v_uxb
      FROM public.loke_products lp
      WHERE lp.cod = v_cod AND lp.active = true
      LIMIT 1;

      IF v_loke_id IS NULL THEN
        RAISE EXCEPTION 'Producto no encontrado: %', v_cod;
      END IF;
      v_is_loke := true;
    END IF;

    v_line_total := v_price * v_cajas * COALESCE(v_uxb, 1);
    v_subtotal := v_subtotal + v_line_total;

    INSERT INTO _bot_order_items VALUES (
      v_cod, v_cajas, v_product_id, v_loke_id,
      v_is_loke, COALESCE(v_uxb, 1), v_price, v_line_total
    );
  END LOOP;

  -- 5. Calcular total con descuentos
  v_total := v_subtotal
    * (1 - COALESCE(v_dto_vol, 0))
    * (1 - v_payment_disc)
    * (1 - v_web_discount);

  -- 6. Insertar orden
  INSERT INTO public.orders (
    auth_user_id, customer_id, customer_code, status,
    payment_method, payment_discount, web_discount, extra_discount,
    subtotal, total
  ) VALUES (
    v_bot_uid, v_customer_id, v_cod_cliente::text, 'pending',
    p_payment_method, v_payment_disc, v_web_discount, COALESCE(v_dto_vol, 0),
    ROUND(v_subtotal, 2), ROUND(v_total, 2)
  ) RETURNING id INTO v_order_id;

  -- 7. Insertar items
  INSERT INTO public.order_items (
    order_id, product_id, loke_product_id, cajas, uxb,
    is_loke, unit_list_price, line_total, source
  )
  SELECT
    v_order_id, i.product_id, i.loke_product_id, i.cajas, i.uxb,
    i.is_loke, i.list_price, ROUND(i.line_total, 2), 'whatsapp-bot'
  FROM _bot_order_items i;

  -- 8. Devolver resultado
  order_id := v_order_id;
  subtotal := ROUND(v_subtotal, 2);
  total := ROUND(v_total, 2);
  items_count := v_items_count;
  RETURN NEXT;
END;
$$;
