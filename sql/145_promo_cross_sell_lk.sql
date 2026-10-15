-- 145 · promo_cross_sell_lk — recomendador de cross-sell por hueco de categoría (solo LK)
--
-- Pedido de Pablo Olejavetzky (2026-10). Detecta, por cliente, las categorías que compran sus pares y
-- él no, y propone el producto activo más vendido de esa categoría. Historial = facturación real de
-- ISIS (isis_lk), no la web. Contexto completo en docs/PROMO-CROSS-SELL.md.
--
-- Se aplica en PaginaLK (kwkclwhmoygunqmlegrg). Lee ISIS (hrxfctzncixxqmpfhskv, schema isis_lk) por el
-- FDW virgilio_db ya existente. Idempotente.
--
-- Diseño: una VISTA MATERIALIZADA (promo.mv_ventas_12m) guarda la foto de ventas de 12 meses, y un cron
-- la refresca. Se usa matview y NO una función de refresco a propósito: una función plpgsql no se puede
-- crear por el MCP de Supabase (su cuerpo lleva `;` dentro del literal $$...$$, que cuelga execute_sql y
-- apply_migration), mientras que `refresh materialized view` es una sola sentencia sin `;` y el cron sí
-- se arma por MCP. El refresh hace un pull completo por FDW (~43k filas): va server-side por el cron, sin
-- el límite de 60 s del MCP. Por eso la matview se crea WITH NO DATA (instantáneo) y se puebla en la
-- primera corrida del cron.
--
-- Nada de esto envía mensajes: es análisis, detrás de la llave wa_envio_automatico.

create schema if not exists promo;

-- Foreign tables a ISIS (isis_lk) vía el server virgilio_db.
create foreign table if not exists promo.isis_documentos (
  id bigint, familia text, fecha date,
  contraparte_codigo text, contraparte_nombre text
) server virgilio_db options (schema_name 'isis_lk', table_name 'documentos');

create foreign table if not exists promo.isis_documento_items (
  documento_id bigint, codigo_articulo text, descripcion text,
  cantidad numeric, cantidad_caja numeric, importe numeric
) server virgilio_db options (schema_name 'isis_lk', table_name 'documento_items');

-- Foto de ventas de los últimos 12 meses (factura_venta), con la categoría de products y la razón social
-- ya limpia. WITH NO DATA: se puebla en la primera corrida del cron (el pull por FDW tarda más de 60 s).
create materialized view if not exists promo.mv_ventas_12m as
select d.contraparte_codigo as cod_cliente,
       btrim(regexp_replace(regexp_replace(d.contraparte_nombre,'[\r\n]+',' ','g'),'\s+',' ','g')) as cliente,
       di.codigo_articulo as cod,
       p.category as categoria,
       di.cantidad_caja, di.importe,
       date_trunc('month', d.fecha)::date as mes
from promo.isis_documento_items di
join promo.isis_documentos d on d.id = di.documento_id
left join public.products p on p.cod = di.codigo_articulo
where d.familia = 'factura_venta'
  and d.fecha >= current_date - interval '1 year'
  and d.contraparte_codigo is not null
with no data;

create index if not exists ix_mv_cli on promo.mv_ventas_12m(cod_cliente);
create index if not exists ix_mv_cat on promo.mv_ventas_12m(categoria);
create index if not exists ix_mv_cod on promo.mv_ventas_12m(cod);

-- Recomendador: por cliente, categoría que compran los pares y él no, con el mejor producto activo.
create or replace view promo.v_promo_gap_12m as
with lineas as (select cod_cliente, cod, categoria from promo.mv_ventas_12m where categoria is not null),
nombres as (select cod_cliente, max(cliente) cliente from promo.mv_ventas_12m group by cod_cliente),
cli_cat as (select distinct cod_cliente, categoria from lineas),
universo as (select distinct cod_cliente from lineas),
total_cli as (select count(*) n from universo),
cat_pen as (
  select categoria, count(distinct cod_cliente) clientes_cat,
         round(100.0*count(distinct cod_cliente)/(select n from total_cli),1) pct_pares
  from lineas group by categoria),
pop as (select cod, count(distinct cod_cliente) compradores from lineas group by cod),
cand_cat as (
  select distinct on (p.category) p.category categoria,
         p.cod cand_cod, p.description cand_desc, p.list_price cand_precio
  from products p left join pop on pop.cod=p.cod
  where p.active and p.category is not null
  order by p.category, coalesce(pop.compradores,0) desc, p.ranking nulls last),
gap as (
  select u.cod_cliente, cp.categoria, cp.pct_pares, cp.clientes_cat
  from universo u cross join cat_pen cp
  where not exists (select 1 from cli_cat c where c.cod_cliente=u.cod_cliente and c.categoria=cp.categoria))
select g.cod_cliente, n.cliente, g.categoria, g.pct_pares, g.clientes_cat,
       cc.cand_cod, cc.cand_desc, cc.cand_precio,
       row_number() over (partition by g.cod_cliente order by g.pct_pares desc, g.clientes_cat desc) rank_cliente
from gap g
join nombres n on n.cod_cliente = g.cod_cliente
left join cand_cat cc on cc.categoria = g.categoria;

-- Cron de refresco: diario 08:20 UTC (~05:20 AR). Idempotente (upsert por jobname en pg_cron >= 1.4).
-- El comando no tiene `;` adentro, así que se arma por MCP. Armado el 2026-10-15.
select cron.schedule('promo_refresh_ventas_12m', '20 8 * * *', 'refresh materialized view promo.mv_ventas_12m');
