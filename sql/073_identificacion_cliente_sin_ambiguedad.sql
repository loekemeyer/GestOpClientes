-- 073 — Identificación del cliente por teléfono: la vinculación aprobada primero y sin adivinar
-- Pedido de Pablo Olejavetzky (28/09). Problema de auditoría "Bot identifica al cliente equivocado…".
-- Va JUNTO con sql/072 (sin la 072, un número "no identificado" podría auto-vincularse con un CUIT).
--
-- Antes: wa_identify_customer buscaba el teléfono en el padrón de teléfonos de Gestión Virgilio (virgilio.whatsapp_clientes,
-- copiado a wa_clientes_telefono) y en la
-- ficha (customers.whatsapp) y devolvía el PRIMERO (LIMIT 1). Medido el 28/09: 70 teléfonos del padrón
-- están en clientes con CUIT distinto y 65 en varios códigos del mismo cliente; además hay números de
-- relleno (…6666) y la ficha tenía números de prueba (Thomy figuraba como "Pro Tatiana Ethel").
-- La vinculación aprobada (bot_customer_whatsapps) se miraba recién si nada de eso encontraba.
--
-- Ahora, en este orden:
--   1. Vinculación explícita (bot_customer_whatsapps) → manda. source = 'vinculo'.
--   2. Teléfono de relleno (menos de 8 dígitos, ≥6 dígitos iguales al final, o ≤2 dígitos distintos)
--      → no identifica.
--   3. Padrón de Gestión + ficha: se juntan TODOS los clientes candidatos. Si son de más de una empresa
--      (CUIT distinto; un cliente sin CUIT cuenta como empresa propia) → no identifica: el bot lo trata
--      como no-cliente y pasa por la vinculación con aprobación humana (sql/072).
--      Si es una sola empresa con varios códigos → el código con el pedido más reciente.
--   source conserva los valores de antes ('wa_clientes_telefono' / 'customers.whatsapp') para no
--   romper a quien los lea.
-- Misma firma y mismo tipo de retorno: webhook, lk_chat-test y las funciones SQL que la usan no cambian.

create or replace function public.wa_identify_customer(p_phone text)
 returns table(cod_cliente text, customer_name text, customer_id uuid, source text)
 language plpgsql
 stable
as $function$
DECLARE
  v_tel text := right(wa_normalize_phone(coalesce(p_phone, '')), 10);
BEGIN
  IF length(v_tel) < 8 THEN RETURN; END IF;

  -- 1) Vinculación aprobada: manda sobre todo lo demás.
  RETURN QUERY
  SELECT c.cod_cliente::text, c.business_name, c.id, 'vinculo'::text
  FROM bot_customer_whatsapps cw
  JOIN customers c ON c.id = cw.customer_id
  WHERE right(wa_normalize_phone(coalesce(cw.whatsapp, '')), 10) = v_tel
  ORDER BY cw.is_primary DESC, cw.created_at DESC
  LIMIT 1;
  IF found THEN RETURN; END IF;

  -- 2) Números de relleno: no identifican a nadie.
  IF v_tel ~ '(\d)\1{5}$'
     OR (SELECT count(DISTINCT d) FROM regexp_split_to_table(v_tel, '') d) <= 2 THEN
    RETURN;
  END IF;

  -- 3) Padrón de Gestión Virgilio + ficha, sin adivinar.
  RETURN QUERY
  WITH cand AS (
    SELECT c.id, c.cod_cliente, c.business_name, 'wa_clientes_telefono'::text AS src,
           coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text) AS empresa
    FROM wa_clientes_telefono wc
    JOIN customers c ON c.cod_cliente::text = wc.cod_cliente::text
    WHERE right(wa_normalize_phone(wc.telefono), 10) = v_tel
    UNION
    SELECT c.id, c.cod_cliente, c.business_name, 'customers.whatsapp'::text,
           coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
    FROM customers c
    WHERE coalesce(c.whatsapp, '') <> ''
      AND right(wa_normalize_phone(c.whatsapp), 10) = v_tel
  )
  SELECT x.cod_cliente::text, x.business_name, x.id, x.src
  FROM cand x
  WHERE (SELECT count(DISTINCT empresa) FROM cand) = 1
  ORDER BY (SELECT max(o.created_at) FROM orders o WHERE o.customer_id = x.id) DESC NULLS LAST,
           x.src = 'wa_clientes_telefono' DESC, x.cod_cliente
  LIMIT 1;
END;
$function$;

-- Monitoreo: teléfonos que el bot NO puede identificar por ambigüedad (para corregir en la fuente de
-- whatsapp_clientes de Gestión Virgilio; NO es Isis, que es facturación).
create or replace view public.v_wa_telefonos_ambiguos as
with cand as (
  select right(wa_normalize_phone(wc.telefono), 10) tel, c.cod_cliente, c.business_name,
         coalesce(nullif(regexp_replace(coalesce(c.cuit,''),'\D','','g'),''), 'id:'||c.id::text) empresa, 'erp' fuente
  from wa_clientes_telefono wc join customers c on c.cod_cliente::text = wc.cod_cliente::text
  union
  select right(wa_normalize_phone(c.whatsapp), 10), c.cod_cliente, c.business_name,
         coalesce(nullif(regexp_replace(coalesce(c.cuit,''),'\D','','g'),''), 'id:'||c.id::text), 'ficha'
  from customers c where coalesce(c.whatsapp,'') <> ''
)
select tel,
       count(distinct empresa) empresas,
       string_agg(distinct cod_cliente::text || ' ' || business_name || ' (' || fuente || ')', ' | ') clientes
from cand
where length(tel) >= 8
group by tel
having count(distinct empresa) > 1;

revoke all on public.v_wa_telefonos_ambiguos from anon, authenticated;

-- Verificación:
--   select * from wa_identify_customer('<tel de Thomy>');           -- → 4210 Garbarino, source 'vinculo'
--   select count(*) from v_wa_telefonos_ambiguos;                    -- ≈ 70 (los que ya no se adivinan)
-- Rollback: volver a la definición de sql/010 (o la guardada en zz_backups antes de aplicar).
