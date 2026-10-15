-- 145 · promo_cross_sell_lk — recomendador de cross-sell por hueco de categoría (solo LK)
--
-- Pedido de Pablo Olejavetzky (2026-10). Detecta, por cliente, las categorías que compran sus pares y
-- él no, y propone el producto activo más vendido de esa categoría. Historial = facturación real de
-- ISIS (isis_lk), no la web. Contexto completo en docs/PROMO-CROSS-SELL.md.
--
-- Se aplica en PaginaLK (kwkclwhmoygunqmlegrg). Lee ISIS (hrxfctzncixxqmpfhskv, schema isis_lk) por el
-- FDW virgilio_db ya existente. Idempotente.
--
-- ⚠ El FDW es lento para transferir filas (un COUNT se empuja al remoto y vuelve al instante, pero traer
-- ~43k filas se pasa de los 60 s del MCP). Por eso la foto de ventas (promo.ventas_raw) se carga con la
-- función promo.refresh_ventas_12m(), que inserta mes por mes y DEBE correr server-side (cron), no por MCP.
-- El primer load de 2026-10 se hizo a mano por tandas trimestrales con el mismo criterio.
--
-- ⚠ La función promo.refresh_ventas_12m() NO se puede crear por el MCP de Supabase: su cuerpo tiene `;`
-- dentro del literal $$...$$ y eso cuelga el MCP hasta el timeout (bug documentado en CLAUDE.md). Hay que
-- crearla desde el SQL editor del dashboard. El resto de esta migración (schema, foreign tables, tablas,
-- vista) sí se aplica por MCP. Al 2026-10-15 todo está aplicado MENOS la función.
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

-- Foto local de ventas de los últimos 12 meses (nace con RLS: regla de respaldos).
create table if not exists promo.ventas_raw (
  cod_cliente text, cod text, cantidad_caja numeric, importe numeric, mes date, categoria text
);
alter table promo.ventas_raw enable row level security;
create index if not exists ix_vr_cli on promo.ventas_raw(cod_cliente);
create index if not exists ix_vr_cat on promo.ventas_raw(categoria);
create index if not exists ix_vr_cod on promo.ventas_raw(cod);

create table if not exists promo.clientes (cod_cliente text, cliente text);
alter table promo.clientes enable row level security;

-- Refresco: recarga ventas_raw (factura_venta, 12m, con categoría de products) y clientes.
-- Mes por mes para no saturar el FDW. CORRER SERVER-SIDE (cron), no por MCP (timeout a los 60 s).
create or replace function promo.refresh_ventas_12m() returns void
language plpgsql security definer set search_path = promo, public as $$
declare m int;
begin
  truncate promo.ventas_raw;
  for m in 0..12 loop
    insert into promo.ventas_raw(cod_cliente, cod, cantidad_caja, importe, mes, categoria)
    select d.contraparte_codigo, di.codigo_articulo, di.cantidad_caja, di.importe,
           date_trunc('month', d.fecha)::date, p.category
    from promo.isis_documento_items di
    join promo.isis_documentos d on d.id = di.documento_id
    left join public.products p on p.cod = di.codigo_articulo
    where d.familia = 'factura_venta'
      and d.fecha >= date_trunc('month', current_date) - make_interval(months => m)
      and d.fecha <  date_trunc('month', current_date) - make_interval(months => m) + interval '1 month'
      and d.contraparte_codigo is not null;
  end loop;
  delete from promo.ventas_raw where mes < date_trunc('month', current_date - interval '1 year');

  truncate promo.clientes;
  insert into promo.clientes(cod_cliente, cliente)
  select distinct on (contraparte_codigo) contraparte_codigo, contraparte_nombre
  from promo.isis_documentos
  where familia='factura_venta' and fecha >= current_date - interval '1 year' and contraparte_codigo is not null
  order by contraparte_codigo, fecha desc;
end $$;

-- Recomendador: por cliente, categoría que compran los pares y él no, con el mejor producto activo.
create or replace view promo.v_promo_gap_12m as
with lineas as (select cod_cliente, cod, categoria from promo.ventas_raw where categoria is not null),
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
select g.cod_cliente,
       btrim(regexp_replace(regexp_replace(cl.cliente,'[\r\n]+',' ','g'),'\s+',' ','g')) as cliente,
       g.categoria, g.pct_pares, g.clientes_cat,
       cc.cand_cod, cc.cand_desc, cc.cand_precio,
       row_number() over (partition by g.cod_cliente order by g.pct_pares desc, g.clientes_cat desc) rank_cliente
from gap g
join promo.clientes cl on cl.cod_cliente=g.cod_cliente
left join cand_cat cc on cc.categoria=g.categoria;

-- Cron de refresco: diario 08:20 UTC (~05:20 AR). Idempotente (cron.schedule hace upsert por jobname en
-- pg_cron >= 1.4). Esta línea SÍ se aplica por MCP: el comando no tiene `;` adentro. Corre en rojo hasta
-- que exista promo.refresh_ventas_12m() (crearla desde el SQL editor). Armado el 2026-10-15 como jobid 87.
select cron.schedule('promo_refresh_ventas_12m', '20 8 * * *', 'select promo.refresh_ventas_12m()');
