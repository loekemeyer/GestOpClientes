-- ============================================================
-- 008_wa_product_match.sql
-- Matching inteligente de productos para el bot de WhatsApp
-- ============================================================
-- Problema: los clientes no usan SKU ni códigos. Dicen
-- "olla tramontina grande", "las sartenes antiadherentes",
-- "abrelatas". Necesitamos encontrar el producto correcto
-- en la tabla products a partir de texto libre.
--
-- Estrategia de 3 capas:
--   1. Aliases curados (tabla product_aliases)
--   2. Similaridad trigrama (pg_trgm) sobre description
--   3. Substring ILIKE como fallback
--
-- Flujo completo:
--   Cliente dice "tienen la olla tramontina 24?"
--     → Claude Haiku extrae: { query: "olla tramontina 24", qty: null }
--     → wa_product_match('olla tramontina 24')
--     → Devuelve top N productos con score
--     → Si 1 resultado con score alto → usar directo
--     → Si varios → presentar opciones al cliente
--     → Si ninguno → pedir que aclare
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Extension pg_trgm para búsqueda por similaridad
-- ─────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────
-- 2. Tabla product_aliases
--    Mapea nombres comunes / apodos / abreviaturas a productos.
--    Cada alias apunta a un product_id O a un grupo de
--    productos (via alias_scope = 'category'/'brand').
-- ─────────────────────────────────────────────────────────────
create table if not exists product_aliases (
  id            bigint generated always as identity primary key,
  product_id    bigint,                       -- FK lógica a products.id (puede ser null si alias_scope != 'product')
  alias         text          not null,       -- el nombre que usa el cliente
  alias_type    text          not null        -- tipo de alias:
                default 'synonym',            --   synonym     = sinónimo directo ("abrelatas" → producto X)
                                              --   colloquial  = nombre coloquial ("la plancha esa")
                                              --   abbreviation = abreviatura ("cuch. asado")
                                              --   brand       = marca como se la nombra ("tramontina", "oster")
                                              --   category    = categoría genérica ("ollas", "sartenes", "cuchillos")
                                              --   size        = variante de medida ("24cm", "grande", "chica")
  alias_scope   text          not null        -- scope del match:
                default 'product',            --   product  = apunta a 1 producto específico
                                              --   group    = apunta a un grupo (se usa filter_value)
  filter_field  text,                         -- campo de products a filtrar (ej: 'brand', 'category')
  filter_value  text,                         -- valor a filtrar (ej: 'Tramontina', 'Ollas')
  priority      int           not null default 50,  -- 1-100, mayor = preferido
  is_active     boolean       not null default true,
  created_at    timestamptz   not null default now(),

  -- Validaciones
  constraint chk_alias_scope check (
    (alias_scope = 'product' and product_id is not null) or
    (alias_scope = 'group' and filter_field is not null and filter_value is not null)
  ),
  constraint chk_alias_type check (
    alias_type in ('synonym', 'colloquial', 'abbreviation', 'brand', 'category', 'size')
  )
);

comment on table product_aliases is
  'Nombres alternativos que los clientes usan para referirse a productos. Curado manualmente.';

-- Índices
create index idx_pa_alias_trgm
  on product_aliases using gin (alias gin_trgm_ops);

create index idx_pa_product
  on product_aliases (product_id)
  where product_id is not null;

create index idx_pa_active
  on product_aliases (is_active)
  where is_active = true;

-- ─────────────────────────────────────────────────────────────
-- 3. Índice trigrama sobre products.description
--    Permite búsqueda fuzzy directa sobre el nombre real
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_products_desc_trgm
  on products using gin (description gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- 4. Función wa_product_match
--    Recibe texto libre, devuelve los mejores matches.
-- ─────────────────────────────────────────────────────────────
create or replace function wa_product_match(
  p_query   text,
  p_limit   int  default 5
)
returns table (
  product_id    bigint,
  cod           text,
  description   text,
  list_price    numeric,
  uxb           int,
  match_source  text,       -- 'alias' | 'trigram' | 'substring'
  match_score   real        -- 0.0 a 1.0
)
language plpgsql security definer stable
as $$
declare
  v_query text := lower(trim(p_query));
begin
  -- Ajustar umbral de similaridad para este query
  -- (más permisivo que el default 0.3 para nombres parciales)
  perform set_config('pg_trgm.similarity_threshold', '0.15', true);

  return query
  with
  -- ─── Capa 1: Aliases exactos y fuzzy ───
  alias_exact as (
    -- Match exacto o casi exacto en aliases curados
    select
      pa.product_id,
      pa.alias_scope,
      pa.filter_field,
      pa.filter_value,
      'alias'::text as source,
      case
        when lower(pa.alias) = v_query then 1.0
        else similarity(lower(pa.alias), v_query) * 0.95
      end::real as score
    from product_aliases pa
    where pa.is_active = true
      and (
        lower(pa.alias) = v_query                -- exacto
        or pa.alias % v_query                     -- trigram similar
        or v_query like '%' || lower(pa.alias) || '%'  -- alias contenido en query
        or lower(pa.alias) like '%' || v_query || '%'  -- query contenido en alias
      )
  ),
  -- Expandir aliases de grupo a productos individuales
  alias_products as (
    -- Aliases que apuntan directo a un producto
    select ae.product_id, ae.source, ae.score
    from alias_exact ae
    where ae.alias_scope = 'product'
      and ae.product_id is not null

    union all

    -- Aliases de grupo: buscar productos que matcheen el filtro
    -- Nota: esto usa queries dinámicas simplificadas para los
    -- campos más comunes (brand, category). Para campos custom
    -- se puede extender.
    select p.id as product_id, ae.source,
           (ae.score * 0.85)::real as score  -- penalizar un poco por ser grupo
    from alias_exact ae
    join products p on p.active = true
    where ae.alias_scope = 'group'
      and ae.filter_field = 'description'
      and lower(p.description) like '%' || lower(ae.filter_value) || '%'
  ),

  -- ─── Capa 2: Similaridad trigrama sobre description ───
  trgm_matches as (
    select
      p.id as product_id,
      'trigram'::text as source,
      greatest(
        similarity(lower(p.description), v_query),
        -- También probar cada palabra del query individualmente
        -- y promediar con el score completo
        (
          select coalesce(avg(
            case when lower(p.description) like '%' || w || '%'
                 then 0.6
                 else similarity(lower(p.description), w) * 0.4
            end
          ), 0)
          from unnest(string_to_array(v_query, ' ')) as w
          where length(w) > 2  -- ignorar palabras cortas
        )
      )::real as score
    from products p
    where p.active = true
      and (
        p.description % v_query
        or lower(p.description) like '%' || v_query || '%'
        -- También matchear por palabras individuales del query
        or exists (
          select 1
          from unnest(string_to_array(v_query, ' ')) as w
          where length(w) > 2
            and lower(p.description) like '%' || w || '%'
        )
      )
  ),

  -- ─── Capa 3: Match por código (exacto o prefijo) ───
  code_matches as (
    select
      p.id as product_id,
      'code'::text as source,
      case
        when lower(p.cod) = v_query then 1.0
        when lower(p.cod) like v_query || '%' then 0.9
        else 0.7
      end::real as score
    from products p
    where p.active = true
      and (
        lower(p.cod) = v_query
        or lower(p.cod) like v_query || '%'
        or lower(p.cod) like '%' || v_query || '%'
      )
  ),

  -- ─── Combinar todas las capas ───
  all_matches as (
    select product_id, source, score from alias_products
    union all
    select product_id, source, score from trgm_matches
    union all
    select product_id, source, score from code_matches
  ),

  -- Quedarse con el mejor score por producto
  best_per_product as (
    select distinct on (am.product_id)
      am.product_id,
      am.source,
      am.score
    from all_matches am
    where am.score > 0.1  -- filtrar ruido
    order by am.product_id, am.score desc
  )

  -- Join con datos del producto y devolver ordenado
  select
    p.id        as product_id,
    p.cod,
    p.description,
    p.list_price,
    p.uxb,
    bp.source   as match_source,
    bp.score    as match_score
  from best_per_product bp
  join products p on p.id = bp.product_id
  where p.active = true
  order by bp.score desc, p.description asc
  limit p_limit;
end;
$$;

comment on function wa_product_match(text, int) is
  'Busca productos por texto libre. Usa aliases curados + trigram similarity + substring match. Devuelve top N con score.';

-- ─────────────────────────────────────────────────────────────
-- 5. RLS
-- ─────────────────────────────────────────────────────────────
alter table product_aliases enable row level security;

create policy "service_role_all" on product_aliases
  for all using (true) with check (true);

create policy "anon_read" on product_aliases
  for select using (is_active = true);

-- ─────────────────────────────────────────────────────────────
-- 6. Seed: aliases iniciales de ejemplo
--    (product_id = null para los de scope 'group')
-- ─────────────────────────────────────────────────────────────
insert into product_aliases (alias, alias_type, alias_scope, filter_field, filter_value, priority) values
  -- Marcas (scope grupo: matchean todos los productos de esa marca)
  ('tramontina',    'brand', 'group', 'description', 'Tramontina', 90),
  ('oster',         'brand', 'group', 'description', 'Oster',      90),
  ('hudson',        'brand', 'group', 'description', 'Hudson',     90),
  ('magefesa',      'brand', 'group', 'description', 'Magefesa',   90),
  ('carol',         'brand', 'group', 'description', 'Carol',      90),

  -- Categorías genéricas
  ('ollas',         'category', 'group', 'description', 'Olla',       80),
  ('olla',          'category', 'group', 'description', 'Olla',       80),
  ('sartenes',      'category', 'group', 'description', 'Sartén',     80),
  ('sarten',        'category', 'group', 'description', 'Sartén',     80),
  ('sarténes',      'category', 'group', 'description', 'Sartén',     80),
  ('cuchillos',     'category', 'group', 'description', 'Cuchillo',   80),
  ('cuchillo',      'category', 'group', 'description', 'Cuchillo',   80),
  ('cucharones',    'category', 'group', 'description', 'Cucharón',   80),
  ('espátulas',     'category', 'group', 'description', 'Espátula',   80),
  ('espatulas',     'category', 'group', 'description', 'Espátula',   80),
  ('cafeteras',     'category', 'group', 'description', 'Cafetera',   80),
  ('cafetera',      'category', 'group', 'description', 'Cafetera',   80),
  ('planchas',      'category', 'group', 'description', 'Plancha',    80),
  ('plancha',       'category', 'group', 'description', 'Plancha',    80),
  ('abrelatas',     'category', 'group', 'description', 'Abrelata',   80),
  ('abre latas',    'category', 'group', 'description', 'Abrelata',   80),
  ('termos',        'category', 'group', 'description', 'Termo',      80),
  ('termo',         'category', 'group', 'description', 'Termo',      80),
  ('pavas',         'category', 'group', 'description', 'Pava',       80),
  ('pava',          'category', 'group', 'description', 'Pava',       80),
  ('tablas',        'category', 'group', 'description', 'Tabla',      80),
  ('tabla de picar','category', 'group', 'description', 'Tabla',      85),
  ('cacerolas',     'category', 'group', 'description', 'Cacerola',   80),
  ('cacerola',      'category', 'group', 'description', 'Cacerola',   80),

  -- Coloquiales / abreviaturas comunes
  ('cuch asado',    'abbreviation', 'group', 'description', 'Cuchillo Asado', 85),
  ('cuch. asado',   'abbreviation', 'group', 'description', 'Cuchillo Asado', 85),
  ('esp. nylon',    'abbreviation', 'group', 'description', 'Espátula Nylon', 85),
  ('cucharón nylon','abbreviation', 'group', 'description', 'Cucharón Nylon', 85),
  ('batería',       'colloquial',   'group', 'description', 'Batería',        80),
  ('baterias',      'colloquial',   'group', 'description', 'Batería',        80),
  ('juego de ollas','colloquial',   'group', 'description', 'Batería',        75),
  ('set de cuchillos','colloquial', 'group', 'description', 'Set Cuchillo',   80),
  ('antiadherente', 'colloquial',   'group', 'description', 'Antiadherente',  75),

  -- Medidas informales → se combinan con otros filtros en el Claude prompt
  ('grande',        'size', 'group', 'description', '28',    40),
  ('chica',         'size', 'group', 'description', '18',    40),
  ('mediana',       'size', 'group', 'description', '22',    40)
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- 7. Función auxiliar: wa_product_match_with_price
--    Versión que aplica el descuento del cliente
-- ─────────────────────────────────────────────────────────────
create or replace function wa_product_match_with_price(
  p_query       text,
  p_customer_id bigint,
  p_limit       int default 5
)
returns table (
  product_id     bigint,
  cod            text,
  description    text,
  list_price     numeric,
  customer_price numeric,
  discount_pct   numeric,
  uxb            int,
  match_source   text,
  match_score    real
)
language plpgsql security definer stable
as $$
declare
  v_discount numeric;
begin
  -- Obtener descuento del cliente
  select coalesce(c.discount_pct, 0)
  into v_discount
  from customers c
  where c.id = p_customer_id;

  if v_discount is null then
    v_discount := 0;
  end if;

  return query
  select
    m.product_id,
    m.cod,
    m.description,
    m.list_price,
    round(m.list_price * (1 - v_discount / 100), 2) as customer_price,
    v_discount as discount_pct,
    m.uxb,
    m.match_source,
    m.match_score
  from wa_product_match(p_query, p_limit) m;
end;
$$;

comment on function wa_product_match_with_price(text, bigint, int) is
  'Igual que wa_product_match pero aplica el descuento del cliente al precio.';
