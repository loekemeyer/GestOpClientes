-- isis_bot_stock_por_empresa — (APLICADA en Gestión 01/10 con el sí de Pablo) stock libre de un artículo POR EMPRESA, para el bot (Pablo Olejavetzky, 01/10).
-- Proyecto Gestión / ISIS (hrxfctzncixxqmpfhskv), NO PaginaLK. Sólo lectura. La llama _shared/stock.ts con
-- getGestionClient (service key).
--
-- Por qué: el bot leía vista_stock_vs_pedidos, que agrupa por gv_cod_stock() y así:
--   1. junta el stock de las dos empresas en cada código. vista_saldos_stock sí lo separa (codigos_duales →
--      "437E LK" / "437E CH"), pero gv_cod_stock le saca el " LK"/" CH" y lo vuelve a sumar. Medido el 01/10:
--      437E de LK = 312 cajas y el bot veía 326; 809E de LK = 342 y veía 399. Y el 043 es "Colador 10 cm" en LK y
--      "Tres en uno" en Chef (GV_Cod_Dos_Productos): las 52 cajas son de Chef.
--   2. guarda los códigos sin el cero ("31"), y el bot buscaba el de la web ("031"): los 17 artículos de la web con
--      cero adelante daban siempre "sin stock" (031 tiene 824 cajas libres).
-- Esta función normaliza el código con el MISMO gv_cod_stock() (una sola regla, no una copia en TypeScript) y devuelve
-- una fila por empresa (LK / CH / Mixto) desde vista_saldos_stock, más si el código es de dos productos
-- (GV_Cod_Dos_Productos) o dual (codigos_duales). Sumando todas las filas da exactamente lo de vista_stock_vs_pedidos
-- (verificado el 01/10 en los 280 códigos con stock).
-- Libre = terminado + excedente + racks + racks_ch + a_guardar + para_envasar (mismo criterio que stock.ts: NO
-- separar_pedidos ni a_facturar, que ya salieron del terminado por picking).

create or replace function public.bot_stock_por_empresa(p_cod text)
returns table(cod text, empresa text, terminado numeric, excedente numeric, racks numeric, racks_ch numeric,
              a_guardar numeric, para_envasar numeric, dos_productos boolean, dual boolean)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with k as (select public.gv_cod_stock(p_cod) as c)
  select k.c, coalesce(s.empresa, 'Mixto'),
         coalesce(sum(s.terminado), 0), coalesce(sum(s.excedente), 0), coalesce(sum(s.racks), 0),
         coalesce(sum(s.racks_ch), 0), coalesce(sum(s.a_guardar), 0), coalesce(sum(s.para_envasar), 0),
         exists (select 1 from "GV_Cod_Dos_Productos" d where public.gv_cod_stock(d.cod) = k.c),
         exists (select 1 from codigos_duales d where public.gv_cod_stock(d.cod) = k.c)
    from k
    left join vista_saldos_stock s on public.gv_cod_stock(s.cod_art) = k.c
   where k.c <> ''
   group by k.c, coalesce(s.empresa, 'Mixto');
$$;
revoke all on function public.bot_stock_por_empresa(text) from public, anon, authenticated;
grant execute on function public.bot_stock_por_empresa(text) to service_role;
