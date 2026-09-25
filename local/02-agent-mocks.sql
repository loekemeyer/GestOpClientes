-- Sandbox local — capa del AGENTE mockeada (identidad + historial + tools).
-- Mismas FIRMAS que las RPCs reales de prod (verificadas 2026-09-25) pero devuelven
-- datos SEMBRADOS, para que runConversation corra local sin FDW a Gestión/ISIS.
-- ⚠ NO son las RPCs reales: no consultan orders/products/customers de verdad.

-- Historial persistente (memoria de la conversación en el sandbox).
create table if not exists bot_historial_chat (
  id        bigserial primary key,
  telefono  text not null,
  rol       text not null check (rol in ('user','assistant')),
  contenido text not null,
  creado_en timestamptz not null default now()
);
create index if not exists idx_bhc_tel on bot_historial_chat(telefono, creado_en);

-- Identidad. Real: wa_identify_customer(p_phone) → (cod_cliente, customer_name, customer_id, source)
-- Sandbox: los teléfonos de prueba resuelven a un cliente ficticio; el resto, no-cliente.
create or replace function wa_identify_customer(p_phone text)
returns table(cod_cliente text, customer_name text, customer_id uuid, source text)
language sql stable as $$
  select v.* from (values
    ('99862', 'CLIENTE SANDBOX LK', '00000000-0000-0000-0000-000000000001'::uuid, 'sandbox')
  ) v(cod_cliente, customer_name, customer_id, source)
  where regexp_replace(coalesce(p_phone,''), '\D', '', 'g') ~ '(1166574113|5491162521635|1162521635)$';
$$;

-- Historial: leer / guardar (firmas reales).
create or replace function bot_leer_historial(p_telefono text, p_limit integer default 20)
returns table(rol text, contenido text, creado_en timestamptz)
language sql stable as $$
  select h.rol, h.contenido, h.creado_en from bot_historial_chat h
  where h.telefono = regexp_replace(coalesce(p_telefono,''), '\D', '', 'g')
  order by h.creado_en desc limit p_limit;
$$;

create or replace function bot_guardar_mensaje(p_telefono text, p_rol text, p_contenido text)
returns void language sql as $$
  insert into bot_historial_chat(telefono, rol, contenido)
  values (regexp_replace(coalesce(p_telefono,''), '\D', '', 'g'), p_rol, p_contenido);
$$;

-- Tool: mis pedidos (datos sembrados; solo para teléfonos de prueba).
create or replace function bot_mis_pedidos(p_telefono text, p_limit integer default 5)
returns table(order_id bigint, fecha date, subtotal numeric, total numeric, payment_method text,
              payment_discount numeric, web_discount numeric, extra_discount numeric,
              items_count integer, cajas_total bigint)
language sql stable as $$
  select v.* from (values
    (1001::bigint, current_date-3,  850000::numeric, 637500::numeric, 'contado', 0.25::numeric, 0.02::numeric, 0::numeric, 4, 12::bigint),
    (1000::bigint, current_date-20, 500000::numeric, 400000::numeric, '30 dias', 0.20::numeric, 0.02::numeric, 0::numeric, 2,  6::bigint)
  ) v(order_id,fecha,subtotal,total,payment_method,payment_discount,web_discount,extra_discount,items_count,cajas_total)
  where exists (select 1 from wa_identify_customer(p_telefono))
  limit p_limit;
$$;

-- Tool: mi entrega (dato sembrado).
create or replace function bot_mi_entrega(p_telefono text)
returns table(np_number text, status text, fecha_entrega date, fecha_pedido date)
language sql stable as $$
  select v.* from (values
    ('LK 1001', 'programado', current_date+2, current_date-3)
  ) v(np_number, status, fecha_entrega, fecha_pedido)
  where exists (select 1 from wa_identify_customer(p_telefono));
$$;

-- Tool: mis descuentos (dato sembrado).
create or replace function bot_mis_descuentos(p_telefono text)
returns table(dto_vol numeric, dto_web numeric, pago_contado numeric, pago_15_30 numeric,
              pago_30_45 numeric, pago_45_60 numeric, pago_90_echeq numeric, business_name text)
language sql stable as $$
  select v.* from (values
    (0.10::numeric, 0.02::numeric, 0.25::numeric, 0.20::numeric, 0.10::numeric, 0.05::numeric, 0.05::numeric, 'CLIENTE SANDBOX LK')
  ) v(dto_vol,dto_web,pago_contado,pago_15_30,pago_30_45,pago_45_60,pago_90_echeq,business_name)
  where exists (select 1 from wa_identify_customer(p_telefono));
$$;

-- Tool: detalle de un pedido (dato sembrado para el pedido 1001).
create or replace function bot_detalle_pedido(p_telefono text, p_order_id bigint)
returns table(cod text, description text, cajas integer, line_total numeric, total_pedido numeric,
              fecha date, payment_method text)
language sql stable as $$
  select v.* from (values
    ('CU-1200', 'Cubiertos línea Premium x12', 2, 300000::numeric, 850000::numeric, current_date-3, 'contado'),
    ('AB-0450', 'Abrelatas reforzado x6',      2, 550000::numeric, 850000::numeric, current_date-3, 'contado')
  ) v(cod,description,cajas,line_total,total_pedido,fecha,payment_method)
  where p_order_id = 1001 and exists (select 1 from wa_identify_customer(p_telefono));
$$;
