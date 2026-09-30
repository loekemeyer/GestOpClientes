-- 112 — Pedidos por WhatsApp: PRECARGA (Pablo Olejavetzky, 30/09).
--
-- Reglas acordadas con Pablo:
--   · Sólo números vinculados y aprobados (bot_cliente_por_whatsapp: bot_customer_whatsapps o padrón del ERP).
--   · El bot pregunta SIEMPRE forma de pago y entrega, muestra el resumen y precarga sólo con el "sí" del cliente.
--   · Precarga = fila en wa_pedido_precarga, NO un pedido: Gestión no ve nada y al cliente no le llega "pedido
--     recibido" hasta que una persona confirma (bot_pedido_confirmar). Con modo 'directo' el bot confirma solo.
--   · Doble pedido: pedido abierto (no entregado) o precarga pendiente de los últimos N días (7) con al menos la
--     mitad de los artículos en común → se avisa antes del resumen y otra vez al confirmar.
--   · La cuenta y la ficha (sheets_payload) son las de la web (pagina-lk-copia/script.js, submitOrder):
--     precio = lista × (1 − dto_vol) (loke: lista), subtotal → × (1 − web) → × (1 − pago); cod 5000 = sólo lista;
--     escala activa = contado obligatorio. Ficha con source 'WhatsApp'. El envío al Sheet lo hace el cron
--     retry-sheets (cada 5 min, pedidos con ficha y sheets_sent = false), igual que Krikos.
--
-- Configuración: app_settings.wa_pedidos_config (JSON, se edita en el dashboard › Configuración del agente).
--   { "activo": false, "modo": "precarga"|"directo", "dup_dias": 7, "dup_pct": 0.5, "dto_web": 0 (Pablo, 30/09: por WhatsApp NO va el 2% web; null = usa web_order_discount),
--     "minimo_envio": null, "minimo_retiro": null }   ← mínimos: sólo aviso, la web no los controla.
--   Sin fila = esos valores (apagado).
-- Aplicada 30/09 a PaginaLK.

create table if not exists public.wa_pedido_precarga (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  phone           text not null,
  customer_id     uuid not null references public.customers(id),
  cod_cliente     bigint,
  business_name   text,
  items           jsonb not null,           -- [{product_id,is_loke,cod_art,descripcion,cajas,uxb,unidades,list_price,unit_price,line_total}]
  condicion_code  int not null,
  condicion_texto text not null,
  payment_discount numeric not null,
  web_discount    numeric not null,
  dto_vol         numeric not null,
  subtotal        numeric not null,
  total           numeric not null,
  entrega         jsonb,                    -- {slot,label,direccion_entrega,zona_expreso,retiro_fecha,retiro_franja}
  observaciones   text,
  sheets_payload  jsonb not null,           -- ficha igual a la web, sin order_number
  duplicado       jsonb,                    -- pedidos/precargas parecidos al momento de precargar
  estado          text not null default 'precargado' check (estado in ('precargado','confirmado','descartado')),
  order_id        bigint references public.orders(id),
  resuelto_por    text,
  resuelto_at     timestamptz,
  nota            text
);
alter table public.wa_pedido_precarga enable row level security;   -- sin políticas: sólo service_role
create index if not exists wa_pedido_precarga_cliente on public.wa_pedido_precarga (customer_id, created_at desc);

-- Config con defaults (apagado).
create or replace function public.wa_pedidos_cfg()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select '{"activo":false,"modo":"precarga","dup_dias":7,"dup_pct":0.5,"dto_web":0,"minimo_envio":null,"minimo_retiro":null}'::jsonb
         || coalesce((select value::jsonb from app_settings where key = 'wa_pedidos_config'), '{}'::jsonb);
$$;

-- Formas de pago de la web (mayorista.html #paymentSelect) con su código Loekemeyer (script.js getPaymentMethodCode).
create or replace function public.wa_condicion_pago(p_code int)
returns table(texto text, dto numeric) language sql immutable as $$
  select t, d from (values
    (8,  'Pago Contado: 25% Dto', 0.25), (9, 'Pago 15-30 días: 20% Dto', 0.20), (10, 'Pago 31-45 días: 15% Dto', 0.15),
    (11, 'Pago 46-60 días: 10% Dto', 0.10), (12, 'Pago 90 días Echeq: 5% Dto', 0.05), (13, 'Pago 120 días Echeq: 0% Dto', 0.00),
    (18, 'Prefiero no decidir ahora: 0% Dto', 0.00)) v(c, t, d)
  where c = p_code;
$$;

-- Parecidos: pedidos abiertos (con ficha, no entregados en Gestión) y precargas pendientes del cliente en los últimos
-- N días que comparten al menos pct de los artículos nuevos.
create or replace function public.wa_pedido_parecidos(p_customer_id uuid, p_cods text[], p_excluir_precarga bigint default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_cfg jsonb := wa_pedidos_cfg();
  v_dias int := coalesce((v_cfg->>'dup_dias')::int, 7);
  v_pct numeric := coalesce((v_cfg->>'dup_pct')::numeric, 0.5);
  v_n int := coalesce(array_length(p_cods, 1), 0);
  v_out jsonb := '[]'::jsonb;
  r record;
  v_ids bigint[];
  v_abiertos bigint[];
begin
  if v_n = 0 then return v_out; end if;
  select array_agg(o.id) into v_ids from orders o
   where o.customer_id = p_customer_id and o.sheets_payload is not null and o.created_at > now() - make_interval(days => v_dias);
  if v_ids is not null then
    select array_agg(e.order_id::bigint) into v_abiertos from bot_estado_pedidos_gv(v_ids) e where e.status is distinct from 'entregado';
    -- sin estado en Gestión todavía = abierto
    v_abiertos := coalesce(v_abiertos, '{}') || array(select x from unnest(v_ids) x
                    where not exists (select 1 from bot_estado_pedidos_gv(array[x]) e));
  end if;
  for r in
    select 'web' as tipo, o.id, o.created_at,
           (select count(distinct it->>'cod_art') from jsonb_array_elements(o.sheets_payload->'items') it
             where it->>'cod_art' = any(p_cods)) as comunes
      from orders o where o.id = any(coalesce(v_abiertos, '{}'))
    union all
    select 'whatsapp', p.id, p.created_at,
           (select count(distinct it->>'cod_art') from jsonb_array_elements(p.items) it where it->>'cod_art' = any(p_cods))
      from wa_pedido_precarga p
     where p.customer_id = p_customer_id and p.estado = 'precargado' and p.id is distinct from p_excluir_precarga
       and p.created_at > now() - make_interval(days => v_dias)
  loop
    if r.comunes::numeric / v_n >= v_pct then
      v_out := v_out || jsonb_build_object('tipo', r.tipo, 'id', r.id,
        'fecha', to_char(r.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM'), 'comunes', r.comunes, 'de', v_n);
    end if;
  end loop;
  return v_out;
end $$;

-- Arma el pedido (y con p_guardar lo precarga). Devuelve {ok, errores[], avisos[], resumen..., precarga_id?}.
-- p_items: [{"cod":"501","cajas":4}, …]. p_slot: sucursal de customer_delivery_addresses (la de "Retira" pide fecha y franja).
create or replace function public.bot_pedido_armar(
  p_telefono text, p_items jsonb, p_condicion_code int, p_slot int,
  p_retiro_fecha date default null, p_retiro_franja text default null, p_observaciones text default null,
  p_guardar boolean default false)
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
    if v_code is distinct from 8 then v_av := v_av || 'Por tu cuenta, este pedido va con pago Contado (25% Dto).'; end if;
    v_code := 8;
  end if;
  select * into v_cond from wa_condicion_pago(v_code);
  if v_cond.texto is null then v_err := v_err || 'forma_de_pago_invalida'; end if;
  v_web := coalesce((v_cfg->>'dto_web')::numeric,
                    (select nullif(value, '')::numeric from app_settings where key = 'web_order_discount'), 0.02);

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    v_err := v_err || 'sin_articulos';
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
    v_err := v_err || 'falta_entrega';
  else
    select * into s from customer_delivery_addresses where customer_id = v_cid and slot = p_slot;
    if s.slot is null then
      v_err := v_err || 'sucursal_invalida';
    else
      v_retira := lower(btrim(coalesce(s.zona_expreso, ''))) = 'retira';
      if v_retira then
        if p_retiro_fecha is null or p_retiro_franja is null then
          v_err := v_err || 'falta_fecha_o_franja_de_retiro';
        elsif p_retiro_fecha < entrega_sumar_habiles(current_date, 3) or wa_proximo_habil(p_retiro_fecha) <> p_retiro_fecha then
          v_err := v_err || format('fecha_retiro_invalida:minimo %s', to_char(entrega_sumar_habiles(current_date, 3), 'DD/MM'));
        elsif p_retiro_franja not in ('9:00 a 12:00', '13:00 a 16:30') then
          v_err := v_err || 'franja_invalida';
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
    'order_total', round(v_total, 2), 'source', 'WhatsApp', 'mode', 'new',
    'items', (select coalesce(jsonb_agg(jsonb_build_object('cod_art', x->>'cod_art', 'cod_original', null,
                'cajas', (x->>'cajas')::int, 'uxb', (x->>'uxb')::int)), '[]'::jsonb) from jsonb_array_elements(v_items) x));

  if p_guardar and cardinality(v_err) = 0 then
    insert into wa_pedido_precarga (phone, customer_id, cod_cliente, business_name, items, condicion_code, condicion_texto,
      payment_discount, web_discount, dto_vol, subtotal, total, entrega, observaciones, sheets_payload, duplicado)
    values (regexp_replace(p_telefono, '\D', '', 'g'), v_cid, c.cod_cliente, c.business_name, v_items, v_code, v_cond.texto,
      v_cond.dto, v_web, v_dto, round(v_sub, 2), round(v_total, 2), v_entrega, nullif(btrim(coalesce(p_observaciones, '')), ''),
      v_payload, case when jsonb_array_length(v_dup) > 0 then v_dup end)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', cardinality(v_err) = 0, 'errores', to_jsonb(v_err), 'avisos', to_jsonb(v_av),
    'cliente', c.business_name, 'items', v_items, 'subtotal', round(v_sub, 2), 'dto_web', v_web,
    'condicion', v_cond.texto, 'dto_pago', v_cond.dto, 'total', round(v_total, 2), 'entrega', v_entrega,
    'parecidos', v_dup, 'precarga_id', v_id);
end $$;

-- Confirma una precarga: crea el pedido CON su ficha en la misma transacción (como submit_order_fast), lo que lo hace
-- visible para Gestión y dispara "pedido recibido". Si hay parecidos nuevos y no se fuerza, no confirma y los devuelve.
create or replace function public.bot_pedido_confirmar(p_precarga_id bigint, p_por text, p_forzar boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  p record; c record; v_order bigint; v_sin_stock text; v_dup jsonb;
begin
  select * into p from wa_pedido_precarga where id = p_precarga_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe'); end if;
  if p.estado <> 'precargado' then return jsonb_build_object('ok', false, 'error', 'ya_' || p.estado, 'order_id', p.order_id); end if;
  v_sin_stock := pedido_items_sin_stock(p.items);
  if v_sin_stock is not null then return jsonb_build_object('ok', false, 'error', 'sin_stock', 'articulos', v_sin_stock); end if;
  v_dup := wa_pedido_parecidos(p.customer_id, array(select x->>'cod_art' from jsonb_array_elements(p.items) x), p.id);
  if jsonb_array_length(v_dup) > 0 and not p_forzar then
    return jsonb_build_object('ok', false, 'error', 'posible_doble_pedido', 'parecidos', v_dup);
  end if;
  select * into c from customers where id = p.customer_id;

  insert into orders (auth_user_id, customer_id, customer_code, status, payment_method, payment_discount, web_discount,
                      extra_discount, is_promo, subtotal, total, placed_by_auth_user_id)
  values (coalesce(c.auth_user_id, '00000000-0000-0000-0000-000000000001'::uuid), p.customer_id, p.cod_cliente::text,
          'pendiente', p.condicion_texto, p.payment_discount, p.web_discount, 0, false, p.subtotal, p.total,
          '00000000-0000-0000-0000-000000000001'::uuid)
  returning id into v_order;
  update orders set sheets_payload = p.sheets_payload || jsonb_build_object('order_number', v_order::text) where id = v_order;

  insert into order_items (order_id, product_id, loke_product_id, cajas, uxb, is_loke, source, unit_list_price, unit_your_price, line_total)
  select v_order,
         case when (x->>'is_loke')::boolean then null else (x->>'product_id')::uuid end,
         case when (x->>'is_loke')::boolean then (x->>'product_id')::uuid end,
         (x->>'cajas')::int, (x->>'uxb')::int, (x->>'is_loke')::boolean, 'whatsapp-bot',
         (x->>'list_price')::numeric, (x->>'unit_price')::numeric, round((x->>'line_total')::numeric, 2)
    from jsonb_array_elements(p.items) x;

  update wa_pedido_precarga set estado = 'confirmado', order_id = v_order, resuelto_por = p_por, resuelto_at = now(),
         duplicado = case when jsonb_array_length(v_dup) > 0 then v_dup else duplicado end
   where id = p.id;
  return jsonb_build_object('ok', true, 'order_id', v_order);
end $$;

create or replace function public.bot_pedido_descartar(p_precarga_id bigint, p_por text, p_nota text default null)
returns jsonb language sql security definer set search_path to 'public' as $$
  update wa_pedido_precarga set estado = 'descartado', resuelto_por = p_por, resuelto_at = now(), nota = p_nota
   where id = p_precarga_id and estado = 'precargado'
  returning jsonb_build_object('ok', true, 'id', id);
$$;

revoke all on function public.bot_pedido_armar(text, jsonb, int, int, date, text, text, boolean) from public, anon, authenticated;
revoke all on function public.bot_pedido_confirmar(bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.bot_pedido_descartar(bigint, text, text) from public, anon, authenticated;
revoke all on function public.wa_pedido_parecidos(uuid, text[], bigint) from public, anon, authenticated;
