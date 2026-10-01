-- 115 — (APLICADA 01/10 con el sí de Pablo) Loekemeyer y Chef por un solo número: cuentas por empresa, teléfonos con empresa e identificación de Chef
-- Pedido de Pablo Olejavetzky (01/10). Tarea de Planify: "Bot: Loekemeyer y Chef por el mismo número".
--
-- El bot atiende a las dos empresas por el mismo número de WhatsApp. El número de cliente NO identifica a nadie entre
-- empresas (315 códigos existen en las dos y en 297 son otro CUIT: el 2444 es Relca en LK y Cencosud en Chef), así que
-- lo que se cruza entre empresas es el CUIT y todo lo que guarda un cod_cliente lleva su empresa al lado.
-- Medido el 01/10: 905 CUIT sólo LK · 357 en las dos · 395 sólo Chef.
--
--   1. bot_cuit_norm(text)        CUIT en 11 dígitos o null (vacío, mal formado o genérico de exterior 55000000xxx);
--                                 el mismo criterio que cuitNorm() de _shared/empresas.ts.
--   2. bot_cuentas (vista)        una fila por cuenta de cliente en cada empresa: LK = customers, CH = chef_padron.
--                                 Es vista y no tabla a propósito: chef_padron ya se refresca solo (sincronizar_chef,
--                                 03:20) y una copia más sería una tabla derivada que se desincroniza.
--   3. bot_telefonos_empresa      copia de GV_Clientes_Whatsapp de Gestión (el padrón de teléfonos CON empresa) para no
--                                 depender de que Gestión responda en cada mensaje. La refresca bot_sync_telefonos_empresa()
--                                 cada hora (cron bot-telefonos-empresa); si Gestión falla, la copia queda como estaba.
--   4. bot_chef_whatsapps         vinculaciones APROBADAS de teléfonos con cuentas de Chef. Va aparte de
--                                 bot_customer_whatsapps a propósito: bot_encolar_recordatorios_25 y trg_notify_despacho
--                                 cruzan esa tabla por cod_cliente sin mirar la empresa, así que un teléfono de Chef
--                                 cargado ahí recibiría los avisos del cliente de LK con el mismo número.
--   5. bot_identificar_chef(tel)  la cuenta de Chef de un teléfono, sólo si todo lo que hay para ese teléfono en las dos
--                                 empresas es el mismo CUIT (mismo criterio que sql/073: no adivinar).
--   6. wa_identify_customer       además mira los teléfonos de Chef: si el teléfono también es de un cliente de Chef con
--                                 OTRO CUIT, ya no identifica a nadie (antes elegía el de LK). Medido el 01/10: 21 de
--                                 los 647 teléfonos que reconocía como un cliente de LK son de un cliente de Chef con otro CUIT.
--                                 La vinculación aprobada (bot_customer_whatsapps) sigue mandando.
--
-- Nada de esto manda mensajes. Rollback: zz_backups.bkp_wa_identify_customer_20261001 + drop de lo nuevo.

-- 1) CUIT normalizado ---------------------------------------------------------------------------------------------------
create or replace function public.bot_cuit_norm(p text)
returns text language sql immutable as $$
  select case when d ~ '^\d{11}$' and d !~ '^55000000' then d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

-- 2) Cuentas por empresa ------------------------------------------------------------------------------------------------
create or replace view public.bot_cuentas with (security_invoker = true) as
  select 'LK'::text as empresa, c.cod_cliente::text as cod_cliente, public.bot_cuit_norm(c.cuit) as cuit,
         c.business_name as razon_social, c.id as customer_id
    from public.customers c
  union all
  select 'CH'::text, p.cod_cliente, public.bot_cuit_norm(p.cuit), p.business_name, null::uuid
    from public.chef_padron p;
revoke all on public.bot_cuentas from anon, authenticated;
comment on view public.bot_cuentas is
  'Cuentas de clientes por empresa (LK = customers, CH = chef_padron). El cod_cliente sólo vale junto con la empresa; entre empresas se cruza por cuit (sql/115).';

-- 3) Teléfonos con empresa ----------------------------------------------------------------------------------------------
create table if not exists public.bot_telefonos_empresa (
  empresa      text not null check (empresa in ('LK', 'CH')),
  cod_cliente  text not null,
  telefono     text not null,              -- últimos 10 dígitos (mismo criterio que wa_identify_customer)
  razon_social text,
  origen       text,
  actualizado  timestamptz,                -- el de Gestión
  copiado_en   timestamptz not null default now(),
  primary key (empresa, cod_cliente, telefono)
);
create index if not exists bot_telefonos_empresa_telefono on public.bot_telefonos_empresa (telefono);
alter table public.bot_telefonos_empresa enable row level security;
revoke all on public.bot_telefonos_empresa from anon, authenticated;
comment on table public.bot_telefonos_empresa is
  'Copia de GV_Clientes_Whatsapp (Gestión) con empresa. La refresca bot_sync_telefonos_empresa() cada hora (sql/115).';

create or replace function public.bot_sync_telefonos_empresa()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- Si Gestión no responde, el select falla, la función aborta y la copia queda como estaba (todo es una transacción).
  select count(*) into n from virgilio.gv_clientes_whatsapp where upper(btrim(empresa)) in ('LK', 'CH');
  if n = 0 then
    raise exception 'GV_Clientes_Whatsapp devolvió 0 teléfonos: no se toca la copia';
  end if;
  delete from public.bot_telefonos_empresa;
  insert into public.bot_telefonos_empresa (empresa, cod_cliente, telefono, razon_social, origen, actualizado)
  select upper(btrim(g.empresa)), btrim(g.cod_cliente), right(public.wa_normalize_phone(g.telefono), 10),
         max(g.razon_social), max(g.origen), max(g.actualizado)
    from virgilio.gv_clientes_whatsapp g
   where upper(btrim(g.empresa)) in ('LK', 'CH')
     and coalesce(btrim(g.cod_cliente), '') <> ''
     and length(right(public.wa_normalize_phone(coalesce(g.telefono, '')), 10)) >= 8
   group by 1, 2, 3;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.bot_sync_telefonos_empresa() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'bot-telefonos-empresa';
select cron.schedule('bot-telefonos-empresa', '23 * * * *', 'select public.bot_sync_telefonos_empresa();');

select public.bot_sync_telefonos_empresa();

-- 4) Vinculaciones aprobadas de Chef ------------------------------------------------------------------------------------
create table if not exists public.bot_chef_whatsapps (
  id           bigserial primary key,
  whatsapp     text not null,
  cod_cliente  text not null,              -- código de CHEF (chef_padron); sin FK: el padrón se recarga entero cada noche
  cuit         text,
  razon_social text,
  request_id   bigint references public.bot_registration_requests(id) on delete set null,
  aprobado_por text,
  created_at   timestamptz not null default now(),
  unique (whatsapp, cod_cliente)
);
alter table public.bot_chef_whatsapps enable row level security;
revoke all on public.bot_chef_whatsapps from anon, authenticated;
comment on table public.bot_chef_whatsapps is
  'Teléfonos vinculados (aprobados por una persona) a cuentas de Chef. Aparte de bot_customer_whatsapps: ésa la leen avisos de LK por cod_cliente sin empresa (sql/115).';

-- 5) Identificación de un cliente de Chef -------------------------------------------------------------------------------
create or replace function public.bot_identificar_chef(p_phone text)
returns table(cod_cliente text, razon_social text, cuit text, fuente text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tel text := right(public.wa_normalize_phone(coalesce(p_phone, '')), 10);
begin
  if length(v_tel) < 8 then return; end if;

  -- 1) Vinculación aprobada.
  return query
  select w.cod_cliente, coalesce(p.business_name, w.razon_social), coalesce(public.bot_cuit_norm(p.cuit), w.cuit), 'vinculo'::text
    from public.bot_chef_whatsapps w
    left join public.chef_padron p on p.cod_cliente = w.cod_cliente
   where right(public.wa_normalize_phone(w.whatsapp), 10) = v_tel
   order by w.created_at desc
   limit 1;
  if found then return; end if;

  -- Números de relleno (mismo filtro que wa_identify_customer).
  if v_tel ~ '(\d)\1{5}$' or (select count(distinct d) from regexp_split_to_table(v_tel, '') d) <= 2 then
    return;
  end if;

  -- 2) Padrón de teléfonos de Gestión: sólo si todos los candidatos de las DOS empresas son el mismo CUIT. La clave es
  --    la misma que usa wa_identify_customer (los dígitos del CUIT o, sin CUIT, la cuenta), así las dos funciones
  --    coinciden en qué teléfono es ambiguo.
  return query
  with cand as (
    select 'CH'::text as emp, t.cod_cliente as cod, p.business_name as rs,
           coalesce(nullif(regexp_replace(coalesce(p.cuit, ''), '\D', '', 'g'), ''), 'ch:' || t.cod_cliente) as clave
      from public.bot_telefonos_empresa t
      join public.chef_padron p on p.cod_cliente = t.cod_cliente
     where t.empresa = 'CH' and t.telefono = v_tel
    union
    select 'LK', c.cod_cliente::text, c.business_name,
           coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
      from public.wa_clientes_telefono wc
      join public.customers c on c.cod_cliente::text = wc.cod_cliente::text
     where right(public.wa_normalize_phone(wc.telefono), 10) = v_tel
    union
    select 'LK', c.cod_cliente::text, c.business_name,
           coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
      from public.customers c
     where coalesce(c.whatsapp, '') <> '' and right(public.wa_normalize_phone(c.whatsapp), 10) = v_tel
    union
    select 'LK', c.cod_cliente::text, c.business_name,
           coalesce(nullif(regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g'), ''), 'id:' || c.id::text)
      from public.bot_customer_whatsapps cw
      join public.customers c on c.id = cw.customer_id
     where right(public.wa_normalize_phone(cw.whatsapp), 10) = v_tel
  )
  select x.cod, x.rs, public.bot_cuit_norm(x.clave), 'gv_clientes_whatsapp'::text
    from cand x
   where x.emp = 'CH' and (select count(distinct clave) from cand) = 1
   order by x.cod
   limit 1;
end $$;
revoke all on function public.bot_identificar_chef(text) from public, anon, authenticated;
grant execute on function public.bot_identificar_chef(text) to service_role;

-- 6) wa_identify_customer: un teléfono que también es de un cliente de Chef con otro CUIT ya no se adivina --------------
create table if not exists zz_backups.bkp_wa_identify_customer_20261001 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wa_identify_customer';
alter table zz_backups.bkp_wa_identify_customer_20261001 enable row level security;

create or replace function public.wa_identify_customer(p_phone text)
returns table(cod_cliente text, customer_name text, customer_id uuid, source text)
language plpgsql stable as $function$
DECLARE
  v_tel text := right(wa_normalize_phone(coalesce(p_phone, '')), 10);
BEGIN
  IF length(v_tel) < 8 THEN RETURN; END IF;

  RETURN QUERY
  SELECT c.cod_cliente::text, c.business_name, c.id, 'vinculo'::text
  FROM bot_customer_whatsapps cw
  JOIN customers c ON c.id = cw.customer_id
  WHERE right(wa_normalize_phone(coalesce(cw.whatsapp, '')), 10) = v_tel
  ORDER BY cw.is_primary DESC, cw.created_at DESC
  LIMIT 1;
  IF found THEN RETURN; END IF;

  IF v_tel ~ '(\d)\1{5}$'
     OR (SELECT count(DISTINCT d) FROM regexp_split_to_table(v_tel, '') d) <= 2 THEN
    RETURN;
  END IF;

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
    UNION
    -- sql/115: teléfonos de clientes de CHEF. Sólo cuentan para la ambigüedad (nunca se devuelven): si el teléfono
    -- también es de un cliente de Chef con otro CUIT, no se identifica a nadie y va a vinculación con revisión humana.
    SELECT NULL::uuid, NULL::bigint, NULL::text, 'chef'::text,
           coalesce(nullif(regexp_replace(coalesce(p.cuit, ''), '\D', '', 'g'), ''), 'ch:' || t.cod_cliente)
    FROM bot_telefonos_empresa t
    JOIN chef_padron p ON p.cod_cliente = t.cod_cliente
    WHERE t.empresa = 'CH' AND t.telefono = v_tel
  )
  SELECT x.cod_cliente::text, x.business_name, x.id, x.src
  FROM cand x
  WHERE x.src <> 'chef'
    AND (SELECT count(DISTINCT empresa) FROM cand) = 1
  ORDER BY (SELECT max(o.created_at) FROM orders o WHERE o.customer_id = x.id) DESC NULLS LAST,
           x.src = 'wa_clientes_telefono' DESC, x.cod_cliente
  LIMIT 1;
END;
$function$;
