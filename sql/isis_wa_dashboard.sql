-- ISIS (hrxfctzncixxqmpfhskv) — Dashboard del pipeline + log de facturas. Ya aplicado en ISIS.
--
-- wa_pipeline_log: log de eventos del pipeline (factura generada → aviso enviado).
--   'factura_generada' lo escribe el trigger real wa_factura_notificar (por cada factura nueva).
--   'aviso_enviado'    lo escribe lk_factura-check al enviar (modo grupo / redirección).
-- wa_dashboard_rango(desde,hasta): métricas por día (excluye simulación):
--   programados = PPP_Programacion_Diaria por fecha_entrega
--   armados     = vista_cola_impresion por armado_ts
--   facturados  = Facturacion_NP por facturado_at
--   enviadas    = wa_pipeline_log event='aviso_enviado'

create table if not exists public.wa_pipeline_log(
  id bigserial primary key,
  event text not null,
  np text, comprobante text, cuit text, fecha date, source text,
  detalle jsonb, at timestamptz not null default now()
);
create index if not exists wa_pipeline_log_at_idx on public.wa_pipeline_log(at);
create index if not exists wa_pipeline_log_event_idx on public.wa_pipeline_log(event);
alter table public.wa_pipeline_log enable row level security;

-- El trigger real agrega el log 'factura_generada' por cada factura nueva (ver también
-- isis_wa_sim_pipeline.sql — esta es la versión vigente de wa_factura_notificar).
create or replace function public.wa_factura_notificar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_source text; r record;
begin
  v_source := case tg_table_schema when 'isis_lk' then 'lk' when 'isis_ch' then 'ch' else tg_table_schema end;
  begin
    insert into public.wa_pipeline_log(event, comprobante, cuit, fecha, source)
    select 'factura_generada', comprobante_id, contraparte_cuit, fecha, v_source
    from new_rows where familia = 'factura_venta';
  exception when others then null; end;
  for r in select distinct contraparte_cuit as cuit, fecha from new_rows
           where familia = 'factura_venta' and contraparte_cuit is not null loop
    begin
      perform net.http_post(
        url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
        headers := jsonb_build_object('Content-Type','application/json'),
        body := jsonb_build_object('source', v_source, 'cuit', r.cuit, 'fecha', r.fecha));
    exception when others then null; end;
  end loop;
  return null;
end $$;

create or replace function public.wa_dashboard_rango(p_desde date, p_hasta date)
returns table(dia date, programados int, armados int, facturados int, enviadas int)
language sql stable security definer set search_path to 'public' as $$
  with dias as (select generate_series(p_desde, p_hasta, interval '1 day')::date d)
  select d,
    (select count(distinct np)::int from public."PPP_Programacion_Diaria" p
       where p.fecha_entrega = to_char(d,'YYYY-MM-DD') and coalesce(p.cod,'')<>'99999' and coalesce(p.np,'') not like '9990%'),
    (select count(distinct np)::int from public.vista_cola_impresion v
       where v.armado_ts::date = d and coalesce(v.np,'') not like '9990%'),
    (select count(distinct np)::int from public."Facturacion_NP" f
       where f.facturado_at::date = d and coalesce(f.cod_cliente,'')<>'99999' and coalesce(f.np,'') not like '9990%'),
    (select count(*)::int from public.wa_pipeline_log l where l.event='aviso_enviado' and l.at::date = d)
  from dias order by d;
$$;

create or replace function public.wa_pipeline_log_reciente(p_limit int default 40)
returns table(event text, comprobante text, cuit text, source text, at timestamptz, detalle jsonb)
language sql stable security definer set search_path to 'public' as $$
  select event, comprobante, cuit, source, at, detalle from public.wa_pipeline_log
  order by at desc limit least(coalesce(p_limit,40),200);
$$;
