-- gp_wa_factura_grupo.sql
-- APLICAR EN EL PROYECTO GP (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- Los schemas de facturas (isis_lk, isis_ch, ...) NO están expuestos en PostgREST,
-- así que supabase-js no puede leerlos con .from('documentos'). Este RPC vive en
-- public (expuesto) y es SECURITY DEFINER, por lo que alcanza esos schemas.
-- Lo usa la edge function lk_factura-consolidar (PaginaLK) vía el puente ISIS.

-- Nota: si ya existe una versión previa con menos columnas, hacer primero
--   drop function if exists public.wa_factura_grupo(text, text, date);
create or replace function public.wa_factura_grupo(
  p_schema text, p_cuit text, p_fecha date
) returns table(
  id bigint, comprobante_id text, numero text, total numeric,
  storage_path text, contraparte_nombre text, confianza text, totales_ok boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_schema not in ('isis_lk','isis_ch','isis','chef') then
    raise exception 'schema no permitido: %', p_schema;
  end if;
  return query execute format(
    'select id, comprobante_id, numero, total, storage_path, contraparte_nombre, confianza, totales_ok
       from %I.documentos
      where familia = ''factura_venta''
        and contraparte_cuit = $1
        and fecha = $2
      order by numero', p_schema)
  using p_cuit, p_fecha;
end;
$$;

grant execute on function public.wa_factura_grupo(text, text, date) to anon, authenticated, service_role;
