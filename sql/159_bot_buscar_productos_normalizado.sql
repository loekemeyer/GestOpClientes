-- Búsqueda de productos insensible a grafía (Pablo, 15/10/2026).
--
-- Problema: bot_buscar_productos comparaba texto crudo, así que toda variante de escritura
-- fallaba: "saca corchos" (separado) daba 0 aunque "sacacorchos" diera 16, "sacacorcho" (singular)
-- no matcheaba "Sacacorchos", y los acentos ("pelapapás") tampoco. Parchearlo con un sinónimo por
-- grafía no escala (es whack-a-mole).
--
-- Fix de raíz: se normaliza AMBOS lados antes de comparar — minúsculas, sin acentos, sin espacios
-- ni signos — y se pliega la "s" final del término buscado (singular/plural). Una sola normalización
-- cubre espacios, acentos, mayúsculas, guiones y singular/plural. NO cubre typos (eso sería trigram).
--
-- Se dejó de matchear por categoría? NO: es load-bearing (medido el 15/10: 29 de 31 matches
-- solo-por-categoría son legítimos — "abrelatas" halla "Abrelata Uña", "colador" halla "Filtro de
-- Café", "sacacorchos" halla "Sac. Doble Impulso"). Que una pelanaranjas caiga en la categoría
-- Peladores al pedir pelapapas lo filtra el agente (regla TIPO DE ARTÍCULO en agente-fijos.ts).
--
-- Aplicado a la base con execute_sql (apply_migration cuelga con cuerpos de función por el bug del
-- `;` del MCP). Idempotente.

-- Normalizador: minúsculas + sin acentos (á é í ó ú ü ñ) + sólo [a-z0-9].
create or replace function public.wa_norm(x text)
returns text language sql immutable
as $$ select regexp_replace(translate(lower(coalesce(x,'')), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]', '', 'g') $$;

-- Búsqueda: expande sinónimos (bot_sinonimos) sobre la forma normalizada y matchea
-- descripción/categoría/subcategoría/código normalizados, plegando la "s" final del término.
-- Misma firma y tipo de retorno que antes; el tool buscar_productos del agente no cambia.
create or replace function public.bot_buscar_productos(p_query text, p_limit integer default 10)
returns table(cod text, category text, subcategory text, description text, list_price numeric, uxb integer, tiene_imagen boolean)
language sql stable security definer set search_path to 'public'
as $func$
  with q as (
    select lower(trim(coalesce(p_query,''))) as raw, public.wa_norm(p_query) as nq
  ),
  valid as (select raw, nq from q where length(raw) between 2 and 100),
  syn as (
    select coalesce(
      (select s.sinonimos from public.bot_sinonimos s, valid where public.wa_norm(s.termino) = valid.nq limit 1),
      (select s.sinonimos from public.bot_sinonimos s, valid where valid.nq like '%'||public.wa_norm(s.termino)||'%' order by length(s.termino) desc limit 1),
      (select array[v.raw] from valid v)
    ) as terms
  ),
  nts as (
    select distinct regexp_replace(public.wa_norm(t),'s$','') as nt
    from syn, unnest(syn.terms) as t
    where t is not null
  )
  select p.cod, p.category, p.subcategory, p.description, p.list_price, p.uxb,
         (array_length(p.images,1) > 0) as tiene_imagen
  from public.products p
  where p.active
    and exists (
      select 1 from nts
      where length(nts.nt) >= 2
        and ( public.wa_norm(p.description) like '%'||nts.nt||'%'
           or public.wa_norm(coalesce(p.category,'')) like '%'||nts.nt||'%'
           or public.wa_norm(coalesce(p.subcategory,'')) like '%'||nts.nt||'%'
           or public.wa_norm(p.cod) like '%'||nts.nt||'%' )
    )
  order by case when public.wa_norm(p.description) like (select public.wa_norm(v.raw) from valid v)||'%' then 0 else 1 end, p.description
  limit least(coalesce(p_limit,10),20)
$func$;

grant execute on function public.wa_norm(text) to service_role;
grant execute on function public.bot_buscar_productos(text, integer) to service_role;
