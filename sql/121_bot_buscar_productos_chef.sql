-- 121 — Búsqueda de productos de CHEF para el bot (Pablo Olejavetzky, 01/10/2026, D008 fase 4, paso A).
--
-- bot_buscar_productos busca sólo en public.products (el catálogo web de Loekemeyer). Los artículos de Chef viven en
-- chef_ext.products (tabla externa a la base propia de Chef, servidor chef_db, misma forma que products): 100 de los 104 activos
-- no existen en el catálogo de Loekemeyer y el bot no los veía.
--
-- Igual que bot_buscar_productos (sinónimos de bot_sinonimos, descripción / categoría / subcategoría / código), con dos diferencias:
--   · lee chef_ext.products y sólo artículos activos con precio y unidades por caja;
--   · NO devuelve precio ni imágenes (paso A: el precio de Chef para cada cliente todavía no está definido) y compara sin acentos
--     ("reposteria" encuentra "Repostería").
-- Sólo la ejecuta service_role (las edge del bot): ni anon ni authenticated.
--
-- APLICADA el 01/10/2026 al proyecto PaginaLK con el "sí" de Pablo (migración bot_buscar_productos_chef). Verificado: existe, sólo service_role
-- la ejecuta; "colador" 5, "tijera" 0, "reposteria" = "repostería" 10, "pelapapas" (sinónimo) 4. Sólo es una función nueva: no cambia datos.

create or replace function public.bot_buscar_productos_chef(p_query text, p_limit integer default 8)
returns table(cod text, category text, subcategory text, description text, uxb integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_q     text := lower(trim(coalesce(p_query, '')));
  v_terms text[];
begin
  if v_q = '' or length(v_q) < 2 or length(v_q) > 100 then
    return;
  end if;

  -- 1) sinónimos: match exacto del término, o parcial dentro de la consulta (el más específico)
  select s.sinonimos into v_terms from public.bot_sinonimos s where s.termino = v_q limit 1;
  if v_terms is null then
    select s.sinonimos into v_terms from public.bot_sinonimos s
     where v_q like '%' || s.termino || '%'
     order by length(s.termino) desc
     limit 1;
  end if;
  if v_terms is null or array_length(v_terms, 1) is null then
    v_terms := array[v_q];
  end if;

  -- 2) productos activos de Chef que cumplan cualquiera de los términos, sin distinguir acentos
  return query
    select p.cod, p.category, p.subcategory, p.description, p.uxb
      from chef_ext.products p
     where p.active = true
       and coalesce(p.list_price, 0) > 0
       and coalesce(p.uxb, 0) > 0
       and exists (
         select 1
           from unnest(v_terms) as t
          where translate(lower(p.description), 'áéíóúüñ', 'aeiouun')                  like '%' || translate(lower(t), 'áéíóúüñ', 'aeiouun') || '%'
             or translate(lower(coalesce(p.category, '')), 'áéíóúüñ', 'aeiouun')       like '%' || translate(lower(t), 'áéíóúüñ', 'aeiouun') || '%'
             or translate(lower(coalesce(p.subcategory, '')), 'áéíóúüñ', 'aeiouun')    like '%' || translate(lower(t), 'áéíóúüñ', 'aeiouun') || '%'
             or lower(p.cod) like '%' || lower(t) || '%'
       )
     order by case when translate(lower(p.description), 'áéíóúüñ', 'aeiouun') like translate(v_q, 'áéíóúüñ', 'aeiouun') || '%' then 0 else 1 end,
              p.description
     limit least(coalesce(p_limit, 8), 20);
end;
$function$;

revoke all on function public.bot_buscar_productos_chef(text, integer) from public, anon, authenticated;
grant execute on function public.bot_buscar_productos_chef(text, integer) to service_role;
