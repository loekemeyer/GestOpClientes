-- 156 — Guardrail de cruce de cliente: un aviso de un cliente no sale al teléfono de OTRO cliente real
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-10-14 · Pablo Olejavetzky · tarea de Planify 5801 (requisito del go-live)
--
-- Problema: la llave (`wa_puede_enviar`) sólo mira SI el número puede recibir (whitelist en `prueba`, todos en `1`).
--   No mira si el número es del cliente al que va dirigido el mensaje. El 14/10 el barrido de lk_factura-check mandó las facturas
--   de 8 grupos de varios clientes a un solo número (Logística): fue un número de prueba y nadie lo recibió, pero con la llave
--   en `1` el mismo error es el CBU y las facturas de un cliente en el chat de otro.
--
-- Regla (la propuesta en la tarea): se BLOQUEA sólo si el teléfono está vinculado a algún cliente real y a ninguno de los que
--   corresponden al mensaje. Se PERMITE: (a) el teléfono es de alguno de los clientes del mensaje (compara por CUIT, así el mismo
--   CUIT con un código LK y otro de Chef cuenta como el mismo cliente), (b) el teléfono no está vinculado a ningún cliente,
--   (c) es un teléfono de prueba (`wa_real_redirect_to`, `wa_envio_test_phone` o `wa_gerencia_phones`), (d) el mensaje no dice
--   a qué cliente va (no se puede juzgar: sigue como hasta hoy) o es de un cliente simulado (cuit 30999…).
--
-- Dónde se aplica (el único punto de salida, sin tocar a los productores):
--   1) `bot_flush_outbox` (la cola `wa_outbox`, por donde salen los avisos): las filas de contexto `order_created`,
--      `retiro_listo` y `tracking_*` traen en `ref_id` el pedido, y de ahí sale el cliente; las de `recordatorio_dto` (el aviso
--      de descuento con alias y CBU) traen `cod_cliente|fecha|condición|días`, y el cliente es ese cod. Si cruza, la fila queda en
--      `held_no_whitelist` con el motivo en `error` (no se reintenta ni se reenvía solo, igual que las retenidas por la llave).
--   2) `wa_puede_enviar_a(phone, cuit, cod_cliente)`: lo usa `_shared/wa-guard.ts` cuando el productor declara el cliente con el
--      header `x-lk-cuit` (hoy lk_factura-check). Sin header, `wa-guard` sigue llamando a `wa_puede_enviar` como siempre.
--
-- Cuidado: los teléfonos cargados en `wa_real_redirect_to` / `wa_gerencia_phones` quedan EXENTOS. Antes de pasar la llave a `1`
--   hay que revisar que ahí sólo haya números internos.
--
-- Rollback: sql/rollback/156_wa_guardrail_cruce_cliente.sql (devuelve bot_flush_outbox a su definición anterior y borra las 5 funciones nuevas).

-- 1) Identidad del cliente al que va el mensaje: lista de claves (CUIT sólo dígitos, o 'id:<uuid>' si el cliente no tiene CUIT).
create or replace function public.wa_claves_de_cliente(p_customer_id uuid default null, p_cuit text default null, p_cod_cliente text default null)
 returns text[]
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct t.k) filter (where t.k is not null), '{}'::text[])
    from (
      select coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text) as k
        from customers c
       where (p_customer_id is not null and c.id = p_customer_id)
          or c.cod_cliente = (case when coalesce(p_cod_cliente, '') ~ '^\d{1,12}$' then p_cod_cliente::bigint end)
      union all
      select regexp_replace(p_cuit, '\D', '', 'g')
       where regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g') ~ '^\d{11}$'
    ) t;
$function$;

-- 2) A qué clientes pertenece un teléfono: las mismas fuentes que wa_identify_customer (vínculo, wa_clientes_telefono,
--    customers.whatsapp y los teléfonos de Chef), pero devuelve TODOS los clientes (esa función devuelve uno solo).
create or replace function public.wa_claves_del_telefono(p_phone text)
 returns text[]
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with t as (select right(wa_normalize_phone(coalesce(p_phone, '')), 10) as v)
  select case when length((select v from t)) < 10 then '{}'::text[]
         else coalesce((
           select array_agg(distinct x.k) from (
             select coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text) as k
               from bot_customer_whatsapps cw
               join customers c on c.id = cw.customer_id, t
              where right(wa_normalize_phone(coalesce(cw.whatsapp, '')), 10) = t.v
             union
             select coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
               from wa_clientes_telefono wc
               join customers c on c.cod_cliente::text = wc.cod_cliente::text, t
              where right(wa_normalize_phone(coalesce(wc.telefono, '')), 10) = t.v
             union
             select coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
               from customers c, t
              where coalesce(c.whatsapp, '') <> ''
                and right(wa_normalize_phone(c.whatsapp), 10) = t.v
             union
             select coalesce(nullif(regexp_replace(coalesce(p.cuit, ''), '\D', '', 'g'), ''), 'ch:' || te.cod_cliente)
               from bot_telefonos_empresa te
               join chef_padron p on p.cod_cliente = te.cod_cliente, t
              where te.empresa = 'CH'
                and right(wa_normalize_phone(coalesce(te.telefono, '')), 10) = t.v
           ) x), '{}'::text[])
         end;
$function$;

-- 3) ¿Es un teléfono de prueba? Los números de las tres listas de prueba que ya existen (comparación por los últimos 10 dígitos).
create or replace function public.wa_telefono_de_prueba(p_phone text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select length(right(wa_normalize_phone(coalesce(p_phone, '')), 10)) = 10
     and exists (
       select 1
         from app_settings s
        cross join lateral regexp_matches(coalesce(s.value, ''), '\d{10,15}', 'g') m
        where s.key in ('wa_real_redirect_to', 'wa_envio_test_phone', 'wa_gerencia_phones')
          and right(m[1], 10) = right(wa_normalize_phone(coalesce(p_phone, '')), 10));
$function$;

-- 4) La decisión: null = puede ir, texto = motivo del bloqueo.
create or replace function public.wa_destino_cruzado(p_phone text, p_cuit text default null, p_cod_cliente text default null, p_customer_id uuid default null)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_pedido text[];
  v_tel text[];
begin
  if regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g') like '30999%' then return null; end if;   -- cliente simulado
  v_pedido := wa_claves_de_cliente(p_customer_id, p_cuit, p_cod_cliente);
  if coalesce(array_length(v_pedido, 1), 0) = 0 then return null; end if;                           -- no dice a qué cliente va
  if wa_telefono_de_prueba(p_phone) then return null; end if;                                       -- teléfono de prueba
  v_tel := wa_claves_del_telefono(p_phone);
  if coalesce(array_length(v_tel, 1), 0) = 0 then return null; end if;                              -- no es de ningún cliente
  if v_tel && v_pedido then return null; end if;                                                    -- es de alguno de los clientes del mensaje
  return 'cruce_cliente: el teléfono pertenece a otro cliente';
end;
$function$;

-- 5) La llave de siempre + el guardrail.
create or replace function public.wa_puede_enviar_a(p_phone text, p_cuit text default null, p_cod_cliente text default null)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select wa_puede_enviar(p_phone) and wa_destino_cruzado(p_phone, p_cuit, p_cod_cliente) is null;
$function$;

revoke all on function public.wa_claves_de_cliente(uuid, text, text) from public, anon, authenticated;
revoke all on function public.wa_claves_del_telefono(text) from public, anon, authenticated;
revoke all on function public.wa_telefono_de_prueba(text) from public, anon, authenticated;
revoke all on function public.wa_destino_cruzado(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.wa_puede_enviar_a(text, text, text) from public, anon, authenticated;
grant execute on function public.wa_claves_de_cliente(uuid, text, text) to service_role;
grant execute on function public.wa_claves_del_telefono(text) to service_role;
grant execute on function public.wa_telefono_de_prueba(text) to service_role;
grant execute on function public.wa_destino_cruzado(text, text, text, uuid) to service_role;
grant execute on function public.wa_puede_enviar_a(text, text, text) to service_role;

-- 6) La cola: antes de despachar, retiene lo que cruzaría de cliente. Es la definición vigente de bot_flush_outbox más el bloque nuevo.
create or replace function public.bot_flush_outbox(p_limit integer default 20)
 returns table(id bigint, phone text, body text, template_name text, template_params jsonb)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_modo text := coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0');
begin
  if v_modo not in ('prueba', '1') then
    return;
  end if;

  update wa_outbox o
     set status = 'held_no_whitelist'
   where o.status = 'pending'
     and not wa_puede_enviar(o.phone);

  -- Guardrail de cruce de cliente (sql/156): el aviso de un cliente sólo sale a un teléfono de ESE cliente.
  --   · avisos de un pedido (order_created, retiro_listo, tracking_*): el cliente sale del pedido (ref_id = orders.id)
  --   · recordatorio_dto (aviso de descuento con alias y CBU): ref_id = 'cod_cliente|fecha|condición|días', el cliente es el cod LK
  update wa_outbox o
     set status = 'held_no_whitelist',
         error  = x.motivo
    from (
      select o2.id,
             wa_destino_cruzado(
               o2.phone, null,
               case when o2.context = 'recordatorio_dto' then split_part(o2.ref_id, '|', 1) end,
               ord.customer_id) as motivo
        from wa_outbox o2
        left join orders ord on ord.id = (case when o2.context <> 'recordatorio_dto' and o2.ref_id ~ '^\d{1,15}$' then o2.ref_id::bigint end)
       where o2.status = 'pending'
         and (o2.context in ('order_created', 'retiro_listo', 'recordatorio_dto') or o2.context like 'tracking\_%')
    ) x
   where o.id = x.id
     and x.motivo is not null;

  return query
  with batch as (
    select o.id
    from wa_outbox o
    where o.status = 'pending'
      and o.attempts < o.max_attempts
    order by o.created_at
    limit p_limit
    for update skip locked
  )
  update wa_outbox o
  set status = 'sending', attempts = attempts + 1
  from batch b
  where o.id = b.id
  returning o.id, o.phone, o.body, o.template_name, o.template_params;
end;
$function$;
