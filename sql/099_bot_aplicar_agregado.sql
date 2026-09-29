-- 099: "Aplicar" de Tareas para un agregado a un pedido pedido por WhatsApp (Pablo, 29/09).
--
-- El cliente pide por WhatsApp sumar artículos o cajas a un pedido ya hecho. El bot confirma modelo y cajas,
-- chequea armado y stock, y deja la alerta (contexto.pedido + contexto.agregar). Una persona aprueba desde
-- Tareas y esto lo aplica.
--
-- Por qué no edit_order_fast: exige auth.uid() del cliente o de un admin de PaginaLK, y el dashboard loguea en
-- OTRO proyecto (Gestión), así que desde la edge function no hay auth.uid(). Esta función repite sus mismas
-- guardas (pedido no enviado a compras, no facturado/entregado) y además exige que no esté en armado.
--
-- Sólo AGREGA (suma cajas a una línea existente o crea una línea). Precio: list_price actual del producto con
-- el dto_vol actual del cliente; el resto del pedido conserva sus importes. Total = subtotal·(1−pago)·(1−web)·(1−extra),
-- la misma fórmula de la web (verificada contra los pedidos 1566-1568 y 415/430/482).
-- Sólo service_role (la llama lk_alertas después de validar al admin).

create or replace function public.bot_aplicar_agregado(p_alerta_id bigint, p_aprobado_por text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alerta record; v_order record; v_dto numeric; v_estado text; v_item jsonb; v_prod record;
  v_agregado numeric := 0; v_subtotal numeric; v_total numeric; v_items_ficha jsonb; v_lineas text[] := '{}';
begin
  select * into v_alerta from wa_alertas_humano where id = p_alerta_id for update;
  if not found then raise exception 'Alerta inexistente'; end if;
  if v_alerta.estado not in ('pendiente','notificado') then raise exception 'La tarea ya estaba resuelta.'; end if;
  if jsonb_typeof(v_alerta.contexto->'agregar') is distinct from 'array' then raise exception 'La tarea no tiene artículos para agregar.'; end if;
  if coalesce((v_alerta.contexto->>'aplicable')::boolean, false) is not true then
    raise exception 'Esta tarea es para cargar a mano (tiene artículos sin stock).';
  end if;

  select o.*, c.dto_vol into v_order from orders o join customers c on c.id = o.customer_id
   where o.id = (v_alerta.contexto->>'pedido')::bigint for update of o;
  if not found then raise exception 'Pedido inexistente'; end if;
  if v_order.enviado_a_compras_at is not null then raise exception 'Pedido ya enviado a compras: no editable.'; end if;
  if exists (select 1 from virgilio.gv_pedido_web_estado_pagina g
              where g.empresa = 'lk' and g.order_id = v_order.id and (g.facturado or g.entregado)) then
    raise exception 'Pedido ya facturado: no se puede modificar.';
  end if;
  select status into v_estado from bot_estado_pedidos_gv(array[v_order.id]) limit 1;
  if v_estado in ('en preparacion','facturado','entregado') then
    raise exception 'El pedido ya está %: no se puede modificar.', v_estado;
  end if;
  v_dto := coalesce(v_order.dto_vol, 0);

  for v_item in select * from jsonb_array_elements(v_alerta.contexto->'agregar') loop
    select id, cod, description, uxb, list_price into v_prod from products
     where id = (v_item->>'product_id')::uuid and active is true;
    if not found then raise exception 'Artículo % inactivo o inexistente.', v_item->>'cod'; end if;
    if (v_item->>'cajas')::int <= 0 then raise exception 'Cantidad inválida para %.', v_prod.cod; end if;
    update order_items set cajas = cajas + (v_item->>'cajas')::int
     where id = (select id from order_items where order_id = v_order.id and product_id = v_prod.id
                   and coalesce(is_loke, false) = false order by id limit 1);
    if not found then
      insert into order_items (order_id, product_id, cajas, uxb, is_loke, source)
      values (v_order.id, v_prod.id, (v_item->>'cajas')::int, v_prod.uxb, false, 'whatsapp');
    end if;
    v_agregado := v_agregado + (v_item->>'cajas')::int * v_prod.uxb * coalesce(v_prod.list_price, 0);
    v_lineas := v_lineas || format('%s %s de %s (cód. %s)', v_item->>'cajas', case when (v_item->>'cajas')::int = 1 then 'caja' else 'cajas' end, v_prod.description, v_prod.cod);
  end loop;

  v_subtotal := coalesce(v_order.subtotal, 0) + v_agregado * (1 - v_dto);
  v_total := v_subtotal * (1 - coalesce(v_order.payment_discount, 0)) * (1 - coalesce(v_order.web_discount, 0))
                        * (1 - coalesce(v_order.extra_discount, 0));
  update orders set subtotal = v_subtotal, total = v_total where id = v_order.id;

  -- Ficha para Gestión: igual que edit_order_fast sin p_sheets_payload (reconstruye los items).
  select jsonb_agg(jsonb_build_object('cod_art', coalesce(p.cod, lp.cod), 'cod_original', null,
                                      'cajas', oi.cajas, 'uxb', oi.uxb) order by oi.id)
    into v_items_ficha
    from order_items oi
    left join products p on not coalesce(oi.is_loke, false) and p.id = oi.product_id
    left join loke_products lp on coalesce(oi.is_loke, false) and lp.id = oi.loke_product_id
   where oi.order_id = v_order.id;
  update orders set sheets_payload = sheets_payload || jsonb_build_object('items', coalesce(v_items_ficha, '[]'::jsonb))
                    || case when sheets_payload ? 'order_total' then jsonb_build_object('order_total', v_total) else '{}'::jsonb end
   where id = v_order.id and sheets_payload is not null;

  update wa_alertas_humano set estado = 'atendido', atendido_por = p_aprobado_por, atendido_at = now(),
         contexto = contexto || jsonb_build_object('aplicado_at', now(), 'total_nuevo', round(v_total))
   where id = p_alerta_id;

  return jsonb_build_object('ok', true, 'pedido', v_order.id, 'creado', v_order.created_at, 'phone', v_alerta.phone,
    'lineas', to_jsonb(v_lineas), 'total_anterior', round(v_order.total), 'total_nuevo', round(v_total));
end;
$$;

revoke all on function public.bot_aplicar_agregado(bigint, text) from public, anon, authenticated;
grant execute on function public.bot_aplicar_agregado(bigint, text) to service_role;
