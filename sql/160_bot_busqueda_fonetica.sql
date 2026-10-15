-- Búsqueda tolerante a errores de tipeo (Pablo, 15/10/2026).
--
-- Problema: un cliente escribe con faltas y el bot no lo encuentra. "Zacacorchos" (seseo, z por s)
-- daba 0 aunque "Sacacorchos" diera 16. pg_trgm (trigram) NO sirve de base: se midió el 15/10 y
-- cuchara~cuchillo = 0,31 queda POR ENCIMA de valde~balde = 0,33 (real) y oya~olla = 0,125 (real,
-- perdido). No hay umbral que separe typo real de palabra distinta.
--
-- Fix: clave FONÉTICA determinística (wa_fon). Pliega las equivalencias reales del español rioplatense
-- a una misma clave, así dos grafías equivalentes COLISIONAN exacto (no es umbral, no hay falso
-- positivo por azar): seseo (z, c ante e/i -> s), b/v -> b, ll/y -> y, h muda -> '', qu/c -> k, y
-- colapso de letras repetidas (jarra -> jara). Medido el 15/10: 9/9 pares de typo reales colisionan
-- (zacacorchos/sacacorchos, oya/olla, valde/balde, bazo/vaso, yave/llave, ervidor/hervidor,
-- sebolla/cebolla, cuchiyo/cuchillo, jarra/jara), 0 falsos (cuchara != cuchillo).
--
-- El seseo cubre de paso el z->c del plural (nuez/nueces): "nuez" halla "Rompenueces Inox" porque
-- wa_fon("nuez")="nues" esta contenido en wa_fon("Rompenueces")="...nueses...". No hace falta regla aparte.
--
-- Se integra como TIER DE RESPALDO en bot_buscar_productos: primero la búsqueda normal (sql/159,
-- normalizada + sinónimos + plural); si da 0, recién ahí entra la fonética. Así ninguna query que ya
-- andaba cambia, y el typo —que antes daba 0— cae a la fonética. Además el lookup de sinónimos gana un
-- escalón fonético, para que "zacacorchos" encuentre la fila de sinónimos "sacacorchos" y herede sus 16.
-- El agente igual confirma por código y pregunta ante la mínima duda (regla PEDIDO SIN ERRORES).
--
-- NO cubre: transposición de letras no fonéticas ni cambios que no sean de sonido (eso sería
-- levenshtein, que en palabras cortas vuelve a chocar; no se agregó porque la fonética cubre el grueso).
--
-- Aplicado a la base con execute_sql (apply_migration cuelga con cuerpos de función por el bug del
-- `;` del MCP). Idempotente. Supersede la definición de bot_buscar_productos de sql/159.

-- Clave fonética: sobre la forma ya normalizada (wa_norm), pliega los sonidos equivalentes del español.
-- Orden importa: h se cae ANTES que nada (así "ch" queda "c" y luego "k", consistente en ambos lados);
-- ll->y antes de colapsar repetidas (si no, "olla"->"ola" chocaría con "ola"). c ante e/i -> s (seseo)
-- antes de mandar el resto de las c a k. translate hace c->k, v->b, z->s de una. Al final colapsa
-- cualquier letra repetida (jarra->jara, y las dobles que dejan los pasos previos).
create or replace function public.wa_fon(x text)
returns text language sql immutable
as $$
  select regexp_replace(
           translate(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(public.wa_norm(x), 'h', '', 'g'),
                 'll', 'y', 'g'),
               'qu', 'k', 'g'),
             'c([ei])', 's\1', 'g'),
           'cvz', 'kbs'),
         '(.)\1+', '\1', 'g')
$$;

-- Búsqueda con respaldo fonético. Misma firma y retorno que sql/159; el tool buscar_productos no cambia.
-- Dos tiers: prim (normalizado, el de siempre) y fon (fonético). fon sólo aporta filas cuando prim está
-- vacío (respaldo puro), ordenado después de prim por la columna tier. Guard de largo >= 3 en la clave
-- fonética para no colisionar claves de 1-2 letras.
create or replace function public.bot_buscar_productos(p_query text, p_limit integer default 10)
returns table(cod text, category text, subcategory text, description text, list_price numeric, uxb integer, tiene_imagen boolean)
language sql stable security definer set search_path to 'public'
as $func$
  with q as (
    select lower(trim(coalesce(p_query,''))) as raw, public.wa_norm(p_query) as nq, public.wa_fon(p_query) as fon
  ),
  valid as (select raw, nq, fon from q where length(raw) between 2 and 100),
  syn as (
    select coalesce(
      (select s.sinonimos from public.bot_sinonimos s, valid where public.wa_norm(s.termino) = valid.nq limit 1),
      (select s.sinonimos from public.bot_sinonimos s, valid where valid.nq like '%'||public.wa_norm(s.termino)||'%' order by length(s.termino) desc limit 1),
      (select s.sinonimos from public.bot_sinonimos s, valid where public.wa_fon(s.termino) = valid.fon limit 1),
      (select array[v.raw] from valid v)
    ) as terms
  ),
  nts as (
    select distinct regexp_replace(regexp_replace(public.wa_norm(t),'([rlndzj])es$','\1'),'s$','') as nt
    from syn, unnest(syn.terms) as t where t is not null
  ),
  fts as (
    select distinct public.wa_fon(t) as ft
    from syn, unnest(syn.terms) as t where t is not null
  ),
  base as (
    select p.cod, p.category, p.subcategory, p.description, p.list_price, p.uxb,
           (array_length(p.images,1) > 0) as tiene_imagen, public.wa_norm(p.description) as nd
    from public.products p where p.active
  ),
  prim as (
    select b.*, 0 as tier from base b
    where exists (
      select 1 from nts where length(nts.nt) >= 2
        and ( b.nd like '%'||nts.nt||'%'
           or public.wa_norm(coalesce(b.category,'')) like '%'||nts.nt||'%'
           or public.wa_norm(coalesce(b.subcategory,'')) like '%'||nts.nt||'%'
           or public.wa_norm(b.cod) like '%'||nts.nt||'%' )
    )
  ),
  fon as (
    select b.*, 1 as tier from base b
    where exists (
      select 1 from fts where length(fts.ft) >= 3
        and ( public.wa_fon(b.description) like '%'||fts.ft||'%'
           or public.wa_fon(coalesce(b.category,'')) like '%'||fts.ft||'%'
           or public.wa_fon(coalesce(b.subcategory,'')) like '%'||fts.ft||'%' )
    )
  ),
  comb as (
    select * from prim
    union all
    select * from fon where not exists (select 1 from prim)
  )
  select c.cod, c.category, c.subcategory, c.description, c.list_price, c.uxb, c.tiene_imagen
  from comb c
  order by c.tier,
           case when c.nd like (select public.wa_norm(v.raw) from valid v)||'%' then 0 else 1 end,
           c.description
  limit least(coalesce(p_limit,10),20)
$func$;

grant execute on function public.wa_fon(text) to service_role;
grant execute on function public.bot_buscar_productos(text, integer) to service_role;
