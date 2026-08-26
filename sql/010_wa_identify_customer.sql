-- ============================================================
-- 010_wa_identify_customer.sql
-- Paso 0: Identificación de cliente por teléfono
-- ============================================================
-- Función que recibe un número de teléfono (formato Meta: 5491130303594)
-- y busca en wa_clientes_telefono con normalización de formato.
--
-- Retorna: cod_cliente (text) o NULL si no se encuentra.
--
-- Fuentes de datos:
--   - wa_clientes_telefono (610 registros, 540 con match a customers)
--   - customers.whatsapp (17 registros, backup)
--
-- El bot debe llamar esta función ANTES de procesar cualquier pregunta.
-- Si retorna NULL → responder con invitación al alta.
-- Si retorna cod_cliente → continuar con la respuesta a la pregunta.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Función auxiliar: normalizar teléfono (solo dígitos)
-- ─────────────────────────────────────────────────────────────
create or replace function wa_normalize_phone(raw text)
returns text
language sql
immutable
as $$
  select regexp_replace(raw, '[^0-9]', '', 'g');
$$;

comment on function wa_normalize_phone is
  'Quita todo lo que no sea dígito de un número de teléfono.';

-- ─────────────────────────────────────────────────────────────
-- 2. Función principal: identificar cliente por teléfono
-- ─────────────────────────────────────────────────────────────
create or replace function wa_identify_customer(p_phone text)
returns table (
  cod_cliente     text,
  customer_name   text,
  customer_id     uuid,
  discount_pct    numeric,
  source          text
)
language plpgsql
stable
as $$
declare
  v_clean   text;
  v_no54    text;
  v_no549   text;
begin
  -- Normalizar el teléfono entrante
  v_clean := wa_normalize_phone(p_phone);

  -- Generar variantes
  -- Formato Meta: 5491130303594 (con 549)
  -- wa_clientes_telefono puede tener: +54 9 11 3030-3594 → 5491130303594
  -- O sin prefijo internacional: 1130303594
  if v_clean ~ '^549' then
    v_no549 := substring(v_clean from 4);  -- quitar '549'
    v_no54  := substring(v_clean from 3);  -- quitar '54'
  elsif v_clean ~ '^54' then
    v_no54  := substring(v_clean from 3);  -- quitar '54'
    v_no549 := v_no54;
  else
    v_no54  := v_clean;
    v_no549 := v_clean;
  end if;

  -- Buscar en wa_clientes_telefono (fuente principal, 610 registros)
  return query
  select
    wc.cod_cliente::text,
    c.business_name,
    c.id,
    c.discount_pct,
    'wa_clientes_telefono'::text as source
  from wa_clientes_telefono wc
  join customers c on c.cod_cliente::text = wc.cod_cliente::text
  where wa_normalize_phone(wc.telefono) in (v_clean, v_no54, v_no549)
     or v_clean in (
       wa_normalize_phone(wc.telefono),
       regexp_replace(wa_normalize_phone(wc.telefono), '^54', ''),
       regexp_replace(wa_normalize_phone(wc.telefono), '^549', '')
     )
  limit 1;

  -- Si ya encontró, salir
  if found then return; end if;

  -- Fallback: buscar en customers.whatsapp (17 registros)
  return query
  select
    c.cod_cliente::text,
    c.business_name,
    c.id,
    c.discount_pct,
    'customers.whatsapp'::text as source
  from customers c
  where c.whatsapp is not null
    and c.whatsapp != ''
    and wa_normalize_phone(c.whatsapp) in (v_clean, v_no54, v_no549)
  limit 1;
end;
$$;

comment on function wa_identify_customer is
  'Paso 0 del bot: identifica un cliente por su número de teléfono WhatsApp.
   Busca en wa_clientes_telefono y customers.whatsapp con normalización de formato.
   Retorna cod_cliente, nombre, id, descuento y fuente. Vacío si no se encuentra.';

-- ─────────────────────────────────────────────────────────────
-- 3. Índice para acelerar la búsqueda normalizada
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_wa_clientes_telefono_norm
  on wa_clientes_telefono (wa_normalize_phone(telefono));
