-- ISIS (hrxfctzncixxqmpfhskv) — Dashboard del pipeline + log de facturas. Ya aplicado en ISIS.
--
-- wa_pipeline_log: log de eventos del pipeline (factura generada → aviso enviado).
--   'factura_generada' lo escribe el trigger real wa_factura_notificar (por cada factura nueva).
--   'aviso_enviado'    lo escribe lk_factura-check al enviar (modo grupo / redirección).
-- wa_dashboard_rango(desde,hasta): métricas por día (excluye simulación):
--   programados = FOTO al inicio del día (wa_prog_snapshot) de la programación de Gestión-Virgilio.
--                 Se congela a las 00:30 ART (cron wa-prog-snapshot-diario, después del job de
--                 programación 00:01 de Gestión) para que NO se encoja cuando los pedidos avanzan
--                 por el pipeline (se arman y salen de la programación viva). Fallback en vivo
--                 para días sin foto. Cuenta por NP (no tanda) los DOS universos válidos:
--                 (a) ISIS remanentes 9xxxx/4xxxx (gv_ppp_programacion_diaria) y (b) web-nativas
--                 'LK xxxx'/'CH xxxxx' (PPP_Web_Programacion, clave empresa+np).
--                 [antes: PPP_Programacion_Diaria cruda / luego gv en vivo — se encogía y sin web]
--   armados     = evento TAL (armado de la NP) en Registros_Produccion_Virgilio por ts_cliente.
--                 [antes: vista_cola_impresion, que es la COLA DE IMPRESIÓN — se vacía al
--                 imprimir la NP, así que como métrica de "armados por día" daba 0]
--   facturados  = Facturacion_NP por facturado_at (distinct NP)
--   enviadas    = wa_pipeline_log event='aviso_enviado' (mensajes: 1 por grupo × destinatario)
--   facturas_enviadas = facturas cubiertas por avisos enviados, dedup por grupo

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

-- ── Foto de "programados" al inicio del día ──────────────────────────────────
-- La programación viva (gv_ppp_programacion_diaria) DRENA a medida que los pedidos
-- avanzan (se arman y salen), así que como métrica del día se encoge. Solución
-- (pedido del usuario): tomar una FOTO al inicio del día y congelar el número.
create table if not exists public.wa_prog_snapshot(
  dia date primary key,
  programados int not null default 0,
  tomado_at timestamptz not null default now()
);
alter table public.wa_prog_snapshot enable row level security;  -- sólo definer/service_role

-- Cuenta distinct NP programados para un día (Gestión, override-aware) y congela el número.
-- greatest(): una corrida posterior nunca BAJA la foto (la programación viva drena durante el
-- día); sólo la sube si Gestión programó más. p_dia null = hoy en hora Argentina.
create or replace function public.wa_snapshot_programados(p_dia date default null)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v_dia date; v_n int;
begin
  v_dia := coalesce(p_dia, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  -- Cuenta los DOS universos de NP válidos (ver comentario del encabezado):
  --   (a) ISIS remanentes (9xxxx/4xxxx) → gv_ppp_programacion_diaria
  --   (b) web-nativas ('LK xxxx'/'CH xxxxx') → PPP_Web_Programacion, clave (empresa, np)
  -- Disjuntos (sin colisión); LK/CH web comparten el entero np → van con empresa en la clave.
  select count(*) into v_n from (
    select btrim(g.np) as k
    from public.gv_ppp_programacion_diaria g
    where left(g.fecha_entrega, 10) = to_char(v_dia,'YYYY-MM-DD')
      and coalesce(g.cod,'')<>'99999' and coalesce(g.np,'') not like '9990%'
    union
    select w.empresa || ' ' || w.np::text
    from public."PPP_Web_Programacion" w
    where w.fecha_entrega = v_dia and coalesce(w.cod_cliente,'')<>'99999'
  ) u;
  insert into public.wa_prog_snapshot(dia, programados, tomado_at)
  values (v_dia, coalesce(v_n,0), now())
  on conflict (dia) do update
    set programados = greatest(public.wa_prog_snapshot.programados, excluded.programados),
        tomado_at = now();
  return coalesce(v_n,0);
end $$;
revoke all on function public.wa_snapshot_programados(date) from public, anon, authenticated;

-- Cron diario: 03:30 UTC = 00:30 ART (después del job de programación 00:01 de Gestión).
select cron.schedule('wa-prog-snapshot-diario', '30 3 * * *', $$select public.wa_snapshot_programados();$$);

drop function if exists public.wa_dashboard_rango(date, date);
create or replace function public.wa_dashboard_rango(p_desde date, p_hasta date)
returns table(dia date, programados int, armados int, facturados int, enviadas int, facturas_enviadas int)
language sql stable security definer set search_path to 'public' as $$
  with dias as (select generate_series(p_desde, p_hasta, interval '1 day')::date d)
  select d,
    -- programados = FOTO al inicio del día (wa_prog_snapshot); fallback en vivo si aún no hay foto
    coalesce(
      (select s.programados from public.wa_prog_snapshot s where s.dia = d),
      (select count(*)::int from (
         select btrim(g.np) as k from public.gv_ppp_programacion_diaria g
           where left(g.fecha_entrega, 10) = to_char(d,'YYYY-MM-DD')
             and coalesce(g.cod,'')<>'99999' and coalesce(g.np,'') not like '9990%'
         union
         select w.empresa || ' ' || w.np::text from public."PPP_Web_Programacion" w
           where w.fecha_entrega = d and coalesce(w.cod_cliente,'')<>'99999'
       ) u)
    ),
    -- armados = armado de la NP (evento TAL en Registros_Produccion_Virgilio) por día
    (select count(distinct regexp_replace(btrim(split_part(r.texto,'|',1)),'\.0+$',''))::int
       from public."Registros_Produccion_Virgilio" r
       where r.opcion = 'TAL' and r.ts_cliente::date = d
         and regexp_replace(btrim(split_part(r.texto,'|',1)),'\.0+$','') not like '9990%'),
    (select count(distinct np)::int from public."Facturacion_NP" f
       where f.facturado_at::date = d and coalesce(f.cod_cliente,'')<>'99999' and coalesce(f.np,'') not like '9990%'),
    -- enviadas = mensajes (una fila de log por grupo × destinatario)
    (select count(*)::int from public.wa_pipeline_log l where l.event='aviso_enviado' and l.at::date = d),
    -- facturas_enviadas = facturas cubiertas por avisos enviados, dedup por grupo
    -- (mismo grupo a 2 destinatarios cuenta una sola vez).
    (select coalesce(sum(nf),0)::int from (
        select distinct on (grp) nf from (
          select coalesce(detalle->>'group_key', detalle->>'grupo_key',
                 cuit || '|' || coalesce(detalle->>'empresa','') || '|' || coalesce(detalle->>'destino','')) as grp,
                 coalesce((detalle->>'n_facturas')::int, 0) as nf
          from public.wa_pipeline_log
          where event='aviso_enviado' and at::date = d
        ) s order by grp, nf desc
     ) u)
  from dias order by d;
$$;

create or replace function public.wa_pipeline_log_reciente(p_limit int default 40)
returns table(event text, comprobante text, cuit text, source text, at timestamptz, detalle jsonb)
language sql stable security definer set search_path to 'public' as $$
  select event, comprobante, cuit, source, at, detalle from public.wa_pipeline_log
  order by at desc limit least(coalesce(p_limit,40),200);
$$;
