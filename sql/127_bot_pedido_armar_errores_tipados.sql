-- 127 — bot_pedido_armar: los errores ya no tiran una excepción (Pablo Olejavetzky, 06/10/2026).
-- ⚠ ESTADO: NO APLICADA TODAVÍA a PaginaLK (kwkclwhmoygunqmlegrg). Espera el "sí" de Pablo Olejavetzky (06/10/2026); al aplicarla,
--   cambiar esta línea por "Aplicada <fecha> a PaginaLK" y verificar en el Simulador con un slot inválido (cliente 4028, slot 2).
--
-- DEFECTO: en PostgreSQL 17, `text[] || 'literal'` (el literal sin tipo) se interpreta como un ARRAY y lanza
--   22P02 "malformed array literal". Las 8 líneas de abajo concatenaban un literal pelado, así que cuando el modelo
--   mandaba una dirección que no es de la cuenta, una forma de pago inválida, sin artículos, sin entrega o una franja
--   de retiro mala, la función NO devolvía su lista de errores: reventaba, el bot decía "No pude armar el pedido" y
--   derivaba a una persona (alerta urgente) en vez de resolverlo con el cliente. Las ramas con format(...) andaban
--   (es text). Reproducido el 06/10 en el Simulador (cliente 4028, slot 2) y en SQL: `do $$ declare v text[] := '{}';
--   begin v := v || 'x'; end $$;` falla; con `'x'::text` anda.
-- ARREGLO: `::text` en esos 8 literales. Nada más cambia (el resto es idéntico a sql/113 y a la función viva).
-- Efectos en cadena: ninguno. Mismo nombre, mismos 9 argumentos y mismo retorno (CREATE OR REPLACE), así que no se toca
--   ningún permiso (se repite el revoke por idempotencia) ni quien la llame (bot-conversation.ts, armar_pedido y
--   confirmar_pedido). Las llamadas que hoy fallan pasan a devolver {ok:false, errores:[…]}.

create or replace function public.bot_pedido_armar(
  p_telefono text, p_items jsonb, p_condicion_code int, p_slot int,
  p_retiro_fecha date default null, p_retiro_franja text default null, p_observaciones text default null,
  p_guardar boolean default false, p_origen text default 'WhatsApp')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_cfg jsonb := wa_pedidos_cfg();
  c record; s record; pr record;
  v_cid uuid;
  v_err text[] := '{}'; v_av text[] := '{}';
  v_list_only boolean; v_dto numeric; v_code int := p_condicion_code; v_cond record;
  v_web numeric; v_items jsonb := '[]'::jsonb; it jsonb; v_cajas int; v_cod text;
  v_sub numeric := 0; v_total numeric; v_sin_stock text; v_retira boolean := false;
  v_entrega jsonb; v_label text; v_payload jsonb; v_dup jsonb; v_min numeric; v_id bigint; v_debt numeric; v_lc numeric;
begin
  select b.customer_id into v_cid from bot_cliente_por_whatsapp(p_telefono) b;
  if v_cid is null then return jsonb_build_object('ok', false, 'errores', jsonb_build_array('cliente_no_identificado')); end if;
  select * into c from customers where id = v_cid;

  v_list_only := c.cod_cliente = 5000;
  v_dto := case when v_list_only then 0 else coalesce(c.dto_vol, 0) end;
  if coalesce(c.escala_activa, false) or v_list_only then
    if v_code is distinct from 8 then v_av := v_av || 'Por tu cuenta, este pedido va con pago Contado (25% Dto).'::text; end if;
    v_code := 8;
  end if;
  select * into v_cond from wa_condicion_pago(v_code);
  if v_cond.texto is null then v_err := v_err || 'forma_de_pago_invalida'::text; end if;
  if p_origen not in ('WhatsApp', 'Cotizador') then v_err := v_err || 'origen_invalido'::text; end if;
  -- Cotizador: el 2% web como en la web. WhatsApp: el de la config (0 por defecto).
  v_web := case when p_origen = 'Cotizador'
                then coalesce((select nullif(value, '')::numeric from app_settings where key = 'web_order_discount'), 0.02)
                else coalesce((v_cfg->>'dto_web')::numeric,
                              (select nullif(value, '')::numeric from app_settings where key = 'web_order_discount'), 0.02) end;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    v_err := v_err || 'sin_articulos'::text;
  else
    for it in select * from jsonb_array_elements(p_items) loop
      v_cod := btrim(it->>'cod'); v_cajas := coalesce((it->>'cajas')::int, 0);
      if v_cod is null or v_cajas <= 0 then v_err := v_err || format('articulo_invalido:%s', coalesce(v_cod, '?')); continue; end if;
      select p.id, p.cod, p.description, p.uxb, p.list_price, false as is_loke into pr
        from products p where p.cod = v_cod and p.active limit 1;
      if pr.id is null then
        select lp.id, lp.cod, lp.description, lp.uxb, lp.list_price, true as is_loke into pr
          from loke_products lp where lp.cod = regexp_replace(v_cod, '^LOKE-', '', 'i') and lp.active limit 1;
      end if;
      if pr.id is null then v_err := v_err || format('articulo_no_encontrado:%s', v_cod); continue; end if;
      v_items := v_items || jsonb_build_object(
        'product_id', pr.id, 'is_loke', pr.is_loke,
        'cod_art', case when pr.is_loke then 'LOKE-' else '' end || btrim(pr.cod),
        'descripcion', pr.description, 'cajas', v_cajas, 'uxb', coalesce(pr.uxb, 1),
        'unidades', v_cajas * coalesce(pr.uxb, 1), 'list_price', coalesce(pr.list_price, 0),
        'unit_price', case when pr.is_loke then coalesce(pr.list_price, 0) else coalesce(pr.list_price, 0) * (1 - v_dto) end,
        'line_total', v_cajas * coalesce(pr.uxb, 1) *
                      (case when pr.is_loke then coalesce(pr.list_price, 0) else coalesce(pr.list_price, 0) * (1 - v_dto) end));
    end loop;
    v_sin_stock := pedido_items_sin_stock(v_items);
    if v_sin_stock is not null then v_err := v_err || format('sin_stock:%s', v_sin_stock); end if;
  end if;
  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub from jsonb_array_elements(v_items) x;
  v_total := v_sub * (1 - v_web) * (1 - coalesce(v_cond.dto, 0));

  -- Entrega
  if p_slot is null then
    v_err := v_err || 'falta_entrega'::text;
  else
    select * into s from customer_delivery_addresses where customer_id = v_cid and slot = p_slot;
    if s.slot is null then
      v_err := v_err || 'sucursal_invalida'::text;
    else
      v_retira := lower(btrim(coalesce(s.zona_expreso, ''))) = 'retira';
      if v_retira then
        if p_retiro_fecha is null or p_retiro_franja is null then
          v_err := v_err || 'falta_fecha_o_franja_de_retiro'::text;
        elsif p_retiro_fecha < entrega_sumar_habiles(current_date, 3) or wa_proximo_habil(p_retiro_fecha) <> p_retiro_fecha then
          v_err := v_err || format('fecha_retiro_invalida:minimo %s', to_char(entrega_sumar_habiles(current_date, 3), 'DD/MM'));
        elsif p_retiro_franja not in ('9:00 a 12:00', '13:00 a 16:30') then
          v_err := v_err || 'franja_invalida'::text;
        end if;
      end if;
      v_label := s.label;
      v_entrega := jsonb_build_object('slot', s.slot, 'label', s.label, 'direccion_entrega', s.direccion_entrega,
        'zona_expreso', s.zona_expreso, 'nombre_expreso', s.nombre_expreso,
        'retiro_fecha', case when v_retira then p_retiro_fecha end, 'retiro_franja', case when v_retira then p_retiro_franja end);
    end if;
  end if;

  -- Mínimo (sólo aviso: la web no lo controla).
  v_min := case when v_retira then (v_cfg->>'minimo_retiro')::numeric else (v_cfg->>'minimo_envio')::numeric end;
  if v_min is not null and v_total < v_min then
    v_av := v_av || format('El pedido no llega al mínimo de $%s.', to_char(v_min, 'FM999G999G999'));
  end if;

  -- Doble pedido
  v_dup := wa_pedido_parecidos(v_cid, array(select x->>'cod_art' from jsonb_array_elements(v_items) x));

  -- Ficha: igual a la web (script.js submitOrder), source WhatsApp.
  v_debt := coalesce(c.debt, 0); v_lc := c.credit_limit;
  v_payload := jsonb_build_object(
    'cod_cliente', btrim(coalesce(c.cod_cliente::text, '')), 'vend', btrim(coalesce(c.vend, '')),
    'condicion_pago', coalesce(v_cond.texto, ''), 'condicion_pago_code', coalesce(v_code, 0),
    'sucursal_entrega', btrim(coalesce(v_label, '')), 'cliente_nuevo', '',
    'observaciones', btrim(coalesce(p_observaciones, '')),
    'retiro_fecha', case when v_retira then to_char(p_retiro_fecha, 'YYYY-MM-DD') end,
    'retiro_franja', case when v_retira then p_retiro_franja end,
    'is_promo', false, 'tipo_documento', 'pedido', 'extra_discount', 0, 'deuda', v_debt, 'credit_limit', v_lc,
    'payment_term', c.payment_term,
    'lc', case when v_lc is not null and v_debt + v_total > v_lc then 'X' else 'OK' end,
    'd', case when v_debt > 0 then 'X' else 'OK' end,
    'pp', coalesce(c.payment_term::text, 'Null'),
    'order_total', round(v_total, 2), 'source', p_origen, 'mode', 'new',
    'items', (select coalesce(jsonb_agg(jsonb_build_object('cod_art', x->>'cod_art', 'cod_original', null,
                'cajas', (x->>'cajas')::int, 'uxb', (x->>'uxb')::int)), '[]'::jsonb) from jsonb_array_elements(v_items) x));

  if p_guardar and cardinality(v_err) = 0 then
    insert into wa_pedido_precarga (phone, customer_id, cod_cliente, business_name, items, condicion_code, condicion_texto,
      payment_discount, web_discount, dto_vol, subtotal, total, entrega, observaciones, sheets_payload, duplicado, origen)
    values (regexp_replace(p_telefono, '\D', '', 'g'), v_cid, c.cod_cliente, c.business_name, v_items, v_code, v_cond.texto,
      v_cond.dto, v_web, v_dto, round(v_sub, 2), round(v_total, 2), v_entrega, nullif(btrim(coalesce(p_observaciones, '')), ''),
      v_payload, case when jsonb_array_length(v_dup) > 0 then v_dup end, p_origen)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', cardinality(v_err) = 0, 'errores', to_jsonb(v_err), 'avisos', to_jsonb(v_av),
    'cliente', c.business_name, 'items', v_items, 'subtotal', round(v_sub, 2), 'dto_web', v_web,
    'condicion', v_cond.texto, 'dto_pago', v_cond.dto, 'total', round(v_total, 2), 'entrega', v_entrega,
    'parecidos', v_dup, 'precarga_id', v_id, 'origen', p_origen);
end $$;

revoke all on function public.bot_pedido_armar(text, jsonb, int, int, date, text, text, boolean, text) from public, anon, authenticated;
