-- 166 — La regla "facturado sólo con el PDF de la factura" también para Chef (proyecto LK)
-- Pedido de Pablo Olejavetzky (16/10/2026, D045): «Si arreglalo», sobre la lista de pedidos de Chef. Auditoría: problema 863.
--
-- Por qué: la lista de pedidos de Chef (_shared/pedidos-marca.ts, pedidosChef) lee el estado de Gestión desde el código y decía
-- "facturado, listo para salir" o "listo para retirar" con la marca de Facturacion_NP, que se llena al descargar el Excel. En 30 días
-- de NP de Chef (49) la factura se subió una mediana de 225 min después del Excel.
--
-- La regla sigue en UNA función (no se copia):
--   wa_factura_pdf_subida_emp(order_id, empresa): la de sql/165 con la empresa como parámetro ('lk' → facturas LK, 'chef' → CH).
--   wa_factura_pdf_subida(order_id): queda igual por fuera y llama a la de arriba con 'lk' (la usan bot_estado_pedidos_gv y el aviso).
--   bot_pedidos_factura_pdf(ids, empresa): la consulta que usa pedidos-marca.ts para los pedidos de Chef con la marca de Gestión.
-- Medido en Chef (49 NP, 30 días) contra el cruce de Gestión: 46 con factura en el cruce. La regla reconoce 48. 1 queda sin
-- reconocer (CH 0072: la factura se subió una hora ANTES de la descarga del Excel). 3 se adelantan más de 1 hora porque el mismo
-- cliente tuvo otra factura antes que la suya (clientes con 3 o más NP en la semana). Antes de esto, las 49 decían "facturado"
-- desde el Excel.

create or replace function public.wa_factura_pdf_subida_emp(p_order_id bigint, p_empresa text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare v_marca text; v_nps integer; v_ok integer; v_cli text; v_desde timestamptz; v_fc integer;
begin
  v_marca := case lower(coalesce(p_empresa, 'lk')) when 'chef' then 'CH' else 'LK' end;
  select count(*),
         count(*) filter (where exists (
           select 1 from virgilio.comprobantes_venta cv
            where cv.marca = v_marca and cv.familia = 'factura_venta' and cv.storage_path is not null
              and cv.contraparte_codigo = x.cod_cliente and cv.created_at >= x.facturado_at)),
         min(x.cod_cliente), min(x.facturado_at)
    into v_nps, v_ok, v_cli, v_desde
    from (select f.cod_cliente, f.facturado_at
            from virgilio.gv_ppp_web_estado ne
            join virgilio.facturacion_np f on f.np = ne.np_label
           where ne.empresa = lower(coalesce(p_empresa, 'lk')) and ne.order_id = p_order_id) x;
  if coalesce(v_nps, 0) = 0 or v_ok < v_nps then return false; end if;
  if v_nps > 1 then
    select count(distinct cv.punto_venta || '-' || cv.numero) into v_fc
      from virgilio.comprobantes_venta cv
     where cv.marca = v_marca and cv.familia = 'factura_venta' and cv.storage_path is not null
       and cv.contraparte_codigo = v_cli and cv.created_at >= v_desde;
    return v_fc >= v_nps;
  end if;
  return true;
exception when others then
  raise warning 'wa_factura_pdf_subida_emp(%, %) falló: %', p_order_id, p_empresa, sqlerrm;
  return false;
end $$;

revoke execute on function public.wa_factura_pdf_subida_emp(bigint, text) from public, anon, authenticated;

create or replace function public.wa_factura_pdf_subida(p_order_id bigint)
 returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.wa_factura_pdf_subida_emp(p_order_id, 'lk');
$$;

create or replace function public.bot_pedidos_factura_pdf(p_ids bigint[], p_empresa text)
 returns table(order_id bigint, pdf boolean) language sql stable security definer set search_path to 'public' as $$
  select i.id, public.wa_factura_pdf_subida_emp(i.id, p_empresa)
    from unnest(coalesce(p_ids, '{}')) i(id);
$$;

revoke execute on function public.bot_pedidos_factura_pdf(bigint[], text) from public, anon, authenticated;
