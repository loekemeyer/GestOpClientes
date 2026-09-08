-- 060 — Los defectos de FAQ que le llegaban al cliente (puntos 17, 19, 20, 23, 24, 26)
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-09-08 · aplicado
--
-- Todo lo de acá se midió ANTES y DESPUÉS con la misma batería de 16 preguntas, corriendo
-- `wa_faq_match` contra la base viva. Los "antes" no son teoría: son lo que el cliente recibía.
--
--   pregunta                          antes                          ahora
--   ────────────────────────────────  ─────────────────────────────  ──────────────────────────
--   "me mandaron un producto roto"    FAQ 31 → "¡Hacemos envíos a    0.001 → lo toma el agente
--                                      todo el país!"
--   "cuanto es el flete a salta"      FAQ 21 → mínimo de compra      0.001 → lo toma el agente
--   "hasta que hora atienden"         FAQ 36 → marcas                0.000 → lo toma el agente
--   "tienen catalogo?"                FAQ 14 → "No encontré el       FAQ 19 catálogo ✅
--   "hay algo nuevo?"                  artículo que mencionás"       FAQ 19 catálogo ✅
--   "tienen local a la calle"          (los cuatro)                  0.001 → lo toma el agente
--   "que horario tienen"                                             FAQ 4 dirección ✅
--   "mi pedido llego incompleto"      FAQ 1 estado (NO se escalaba)  FAQ 35 needs_human ✅
--   "donde queda el deposito"         lista de pedidos               la dirección ✅
--   "venden ollas de acero"           "Sí, trabajamos con ."         agente (inteligencia) ✅
--
--   Controles que NO se movieron: "cuando llega mi pedido" (4.001), "datos para transferencia",
--   "tienen stock del 505" (5.001) y "que descuentoss tengo" — este último es el que prueba que
--   el rescate de typos sigue vivo después de apretarlo.
--
-- ── 18. El rescate difuso agarraba cualquier cosa ──────────────────────────────────────────
-- `wa_faq_match` daba +1 —lo que `faq.ts` toma como match sólido— a cualquier keyword con
-- `word_similarity >= 0.55`, **incluso de 5 letras**. Una palabra corta se parece a demasiadas
-- cosas: por eso un reclamo por rotura terminaba en "¡Hacemos envíos a todo el país!".
-- Ahora el rescate mira sólo keywords de **8+ caracteres** y exige **0.75**. Sigue arreglando
-- typos ("descuentoss" → descuentos, que es para lo que estaba), pero ya no hermana palabras
-- distintas.
--
-- ROLLBACK: volver a `length(k.nk) >= 8` sin la condición y el umbral a 0.55.

create or replace function public.wa_faq_match(p_text text)
returns table(faq_id bigint, category text, subcategory text, automation_level text, bot_response text,
              institutional_response text, web_first_response text, fallback_label text,
              requires_db_lookup boolean, db_lookup_type text, requires_product_match boolean, match_score numeric)
language plpgsql
stable security definer
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
      -- v2 (punto 18): el rescate difuso es para TYPOS, no para emparentar palabras distintas.
      coalesce((
        select max(word_similarity(k.nk, q))
        from (
          select distinct trim(regexp_replace(unaccent(lower(kw)), '[^a-z0-9 ]', ' ', 'g')) as nk
          from unnest(f.keywords) kw
        ) k
        where k.nk <> '' and length(k.nk) >= 8
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
      + case when s.kw_score = 0 and s.sim >= 0.75 then 1 else 0 end
      + least(s.sim, 0.999) * 0.001)::numeric as match_score
  from scored s
  order by match_score desc, s.priority desc
  limit 5;
end;
$function$;

-- ── Backup de las filas que se tocan (protocolo) ───────────────────────────────────────────
create table if not exists public.wa_faq_bkp_20260908 as
select * from public.wa_faq where id in (4,14,34,35,36,37,39);
-- Restore: update public.wa_faq f set ... from public.wa_faq_bkp_20260908 b where b.id = f.id;

-- ── 20. FAQ 14 (stock) le robaba los intents a todo el mundo ───────────────────────────────
-- Tenía `tienen`, `hay`, `queda`, `quedan`, `disponible` como keywords, con prioridad 60 gana
-- empates. Medido: "tienen catalogo?", "que horario tienen", "hay algo nuevo?" y "tienen local
-- a la calle" recibían los cuatro **"No encontré el artículo que mencionás"**.
update public.wa_faq
   set keywords = array['stock','stock de','tienen stock','hay stock','disponibilidad',
                        'hay disponible','esta disponible','agotado','sin stock','reposicion']
 where id = 14;

-- ── 17. La dirección del depósito era inalcanzable ─────────────────────────────────────────
-- `sql/021` le puso `db_lookup_type='order_status'` a la FAQ 4, y en `faq.ts` toda FAQ con
-- lookup implementado sirve el lookup y **descarta el texto**. Resultado: "¿dónde queda el
-- depósito?" devolvía la lista de pedidos, y Virgilio 2788 no salía nunca.
update public.wa_faq set db_lookup_type = null, requires_db_lookup = false where id = 4;

-- ── 19. Lookups declarados y NO implementados ──────────────────────────────────────────────
-- `faq.ts` sólo maneja order_status, customer_discount, product_price, product_stock,
-- order_modify y payment_data. Las que declaraban `product_search` servían la plantilla con el
-- token vacío: **"Sí, trabajamos con ."** y **"Tenemos estas opciones:"** y nada.
-- Pasan a `inteligencia`, o sea las contesta el agente, que sí sabe buscar.
update public.wa_faq
   set automation_level = 'inteligencia', requires_db_lookup = false, db_lookup_type = null
 where id in (34, 36, 37);
-- Cancelar un pedido lo mira un humano, no el agente.
update public.wa_faq
   set automation_level = 'needs_human', requires_db_lookup = false, db_lookup_type = null
 where id = 39;
update public.wa_faq set requires_db_lookup = false, db_lookup_type = null where id = 35;

-- ── 26. `automation_level` incoherente → el dashboard mentía ───────────────────────────────
update public.wa_faq set automation_level = 'full_auto' where id = 41;   -- es estática

-- ── 24. Un reclamo por faltante no se escalaba ─────────────────────────────────────────────
-- "mi pedido llego incompleto" ganaba la FAQ 1 (estado del pedido, 2.001) sobre la 35
-- (reclamo/faltante, 1.001), porque "mi pedido" son dos palabras y "incompleto" una.
-- Con keywords de tres palabras el reclamo pasa a 6.001 y se escala como corresponde.
update public.wa_faq
   set keywords = keywords || array['pedido llego incompleto','pedido llegó incompleto',
                                    'llego incompleto','llegó incompleto','vino incompleto']
 where id = 35;

-- ── 23. Dos tokens guardados CON llaves ────────────────────────────────────────────────────
-- Contra el estándar que declara `sql/051` y contra las otras 20 filas. El front envuelve otra
-- vez (`{{` + token + `}}`), así que el editor ofrecía `{{{{alias}}}}` y el cliente terminaba
-- recibiendo **"Alias: {loeke.srl}"**.
update public.wa_faq_lookup_tokens set token = btrim(token, '{}')
 where token like '%{%' or token like '%}%';
-- Y la fila stale de un lookup que `sql/055` eliminó.
delete from public.wa_faq_lookup_tokens where db_lookup_type = 'seller_contact';
