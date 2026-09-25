-- Sandbox local — esquema self-contained del camino FAQ (0 IA).
-- Fiel a prod: columnas de sql/007 + las 3 que agregan migraciones posteriores
-- (web_first_response, fallback_label, requires_product_match) que usa wa_faq_match (sql/054).
-- NO trae FDW / cron / Vault: es el subconjunto que corre en un Postgres pelado.
create extension if not exists unaccent;
create extension if not exists pg_trgm;

create table if not exists wa_faq (
  id                     bigint generated always as identity primary key,
  category               text not null,
  category_label         text not null,
  subcategory            text,
  automation_level       text not null default 'full_auto',
  sample_question        text not null,
  keywords               text[] not null default '{}',
  bot_response           text not null,
  institutional_response text,
  web_first_response     text,
  fallback_label         text,
  requires_db_lookup     boolean not null default false,
  requires_product_match boolean not null default false,
  db_lookup_type         text,
  priority               int not null default 50,
  frequency_count        int not null default 0,
  frequency_pct          numeric(5,2) default 0,
  is_active              boolean not null default true,
  notes                  text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Matcher determinístico (sql/054): unaccent + \m inicio de palabra + rescate difuso pg_trgm.
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
      coalesce((
        select sum(array_length(string_to_array(k.nk, ' '), 1))::numeric
        from (
          select distinct trim(regexp_replace(unaccent(lower(kw)), '[^a-z0-9 ]', ' ', 'g')) as nk
          from unnest(f.keywords) kw
        ) k
        where k.nk <> '' and q ~ ('\m' || k.nk)
      ), 0) as kw_score,
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
    (s.kw_score
      + case when s.kw_score = 0 and s.sim >= 0.55 then 1 else 0 end
      + least(s.sim, 0.999) * 0.001)::numeric as match_score
  from scored s
  order by match_score desc, s.priority desc
  limit 5;
end;
$function$;
