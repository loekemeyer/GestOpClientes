-- 054_wa_faq_match_smart.sql
-- Mejora la identificación de FAQs (matcher determinístico, 0 tokens).
-- Reemplaza el matcher viejo (substring crudo LIKE '%kw%' sobre keywords, sin
-- normalizar) que tenía tres fallas:
--   1) acentos rompían el match (kw "pago" no matcheaba "cómo págo").
--   2) substring = falsos positivos (kw "ola" matcheaba "chocolate"; "?" matcheaba todo).
--   3) sin tolerancia a typos.
--
-- Nuevo wa_faq_match:
--   • Normaliza texto y keywords: unaccent + lower + sólo [a-z0-9 ] + espacios colapsados.
--   • Matchea por INICIO de palabra (\m) → mata falsos positivos de substring
--     ("ola" ya NO matchea "chocolate") pero tolera plurales/conjugaciones.
--   • Dedup de keywords ya normalizados → no doble-cuenta pares acentuados
--     (ej. "cuánto sale" / "cuanto sale" cuentan una sola vez).
--   • Peso por especificidad: peso = cantidad de palabras del keyword (una frase
--     "datos para pagar" pesa 3, "pago" pesa 1) → la FAQ más específica gana.
--   • Rescate difuso (pg_trgm word_similarity >= 0.55) para typos cuando no hubo
--     ningún keyword sólido.
--   • match_score pasa de integer (conteo) a numeric. Corte limpio: match real
--     >= 1.001; sin match <= 0.001. faq.ts usa umbral 1.
--
-- Idempotente (create extension if not exists / create or replace / update guardado).

create extension if not exists unaccent;

-- El tipo de retorno cambia (match_score integer → numeric) → hay que drop primero.
drop function if exists public.wa_faq_match(text);

create or replace function public.wa_faq_match(p_text text)
returns table(
  faq_id bigint, category text, subcategory text, automation_level text,
  bot_response text, institutional_response text, web_first_response text,
  fallback_label text, requires_db_lookup boolean, db_lookup_type text,
  requires_product_match boolean, match_score numeric
)
language plpgsql stable security definer
as $function$
declare
  q text;
begin
  -- Normalización del texto del cliente.
  q := regexp_replace(unaccent(lower(coalesce(p_text, ''))), '[^a-z0-9 ]', ' ', 'g');
  q := trim(regexp_replace(q, '\s+', ' ', 'g'));
  if q = '' then return; end if;

  return query
  with scored as (
    select
      f.id, f.category, f.subcategory, f.automation_level,
      f.bot_response, f.institutional_response, f.web_first_response,
      f.fallback_label, f.requires_db_lookup, f.db_lookup_type,
      f.requires_product_match, f.priority,
      -- (a) keywords DISTINTOS ya normalizados (no doble-cuenta acentos),
      --     anclados a inicio de palabra (\m). Peso = cantidad de palabras.
      coalesce((
        select sum(array_length(string_to_array(k.nk, ' '), 1))::numeric
        from (
          select distinct trim(regexp_replace(unaccent(lower(kw)), '[^a-z0-9 ]', ' ', 'g')) as nk
          from unnest(f.keywords) kw
        ) k
        where k.nk <> '' and q ~ ('\m' || k.nk)
      ), 0) as kw_score,
      -- (b) similitud difusa (pg_trgm) para typos.
      coalesce((
        select max(word_similarity(k.nk, q))
        from (
          select distinct trim(regexp_replace(unaccent(lower(kw)), '[^a-z0-9 ]', ' ', 'g')) as nk
          from unnest(f.keywords) kw
        ) k
        where k.nk <> ''
      ), 0) as sim
    from wa_faq f
    where f.is_active = true
  )
  select
    s.id, s.category, s.subcategory, s.automation_level,
    s.bot_response, s.institutional_response, s.web_first_response,
    s.fallback_label, s.requires_db_lookup, s.db_lookup_type,
    s.requires_product_match,
    -- keywords + rescate difuso (si no hubo keyword) + micro-desempate por similitud
    (s.kw_score
      + case when s.kw_score = 0 and s.sim >= 0.55 then 1 else 0 end
      + least(s.sim, 0.999) * 0.001)::numeric as match_score
  from scored s
  order by match_score desc, s.priority desc
  limit 5;
end;
$function$;

-- La FAQ de alta (id=6, needs_human) escalaba a un humano cuando el no-cliente
-- pedía registrarse. Ahora el intake self-service (wa_prospect_leads, en el
-- webhook) toma los datos paso a paso → esta FAQ ya no debe interceptar.
update public.wa_faq set is_active = false, updated_at = now()
where id = 6 and subcategory = 'alta_cliente' and is_active = true;
