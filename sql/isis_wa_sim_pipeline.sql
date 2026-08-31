-- ISIS (Control Partes Talleristas / hrxfctzncixxqmpfhskv) — pipeline REAL de facturación
-- + driver del simulador end-to-end. NO aplicar en PaginaLK. Ya está aplicado en ISIS.
--
-- El pipeline es el de producción; la ÚNICA diferencia en modo prueba es el desvío final
-- (lk_factura-check entrega al módulo web en vez de WhatsApp) y que sólo procesa datos de
-- PRUEBA (cuit '30999…' / cod '99999' / NP '9990…' / direccion 'SIM-…'). Todo se limpia con
-- wa_sim_cleanup_all() y no interfiere con la operación real.
--
-- Piezas del viernes (ya existían): wa_np_snapshot(_run), wa_grupo_listo,
-- wa_grupo_completo_check, trigger wa_np_facturado_trg sobre "Facturacion_NP".

-- ── Trigger real de "grupo completo" encendido (sólo encola en wa_grupo_listo) ──
alter table public."Facturacion_NP" enable trigger wa_np_facturado_trg;

-- ── Trigger real sobre documentos (LK + CH): avisa a PaginaLK lk_factura-check ──
create or replace function public.wa_factura_notificar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_source text; r record;
begin
  v_source := case tg_table_schema when 'isis_lk' then 'lk' when 'isis_ch' then 'ch' else tg_table_schema end;
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

drop trigger if exists trg_factura_notificar_lk on isis_lk.documentos;
create trigger trg_factura_notificar_lk after insert on isis_lk.documentos
  referencing new table as new_rows for each statement execute function public.wa_factura_notificar();
drop trigger if exists trg_factura_notificar_ch on isis_ch.documentos;
create trigger trg_factura_notificar_ch after insert on isis_ch.documentos
  referencing new table as new_rows for each statement execute function public.wa_factura_notificar();

-- ── Control del pedido de prueba (mapeo cuit↔cod, destino, NPs) ──
create table if not exists public.wa_sim_control (
  sim_id uuid primary key default gen_random_uuid(), cuit text not null, fecha date not null,
  np_esperados integer not null default 1, business_name text, metodo text not null default 'no_decidido',
  cod_cliente text, direccion text, tanda text, source text default 'lk', np_list text[] default '{}',
  created_at timestamptz not null default now(), unique (cuit, fecha));
alter table public.wa_sim_control enable row level security;

-- ── Driver: sembrar pedido en la PPP + snapshot (recorrido real) ──
create or replace function public.wa_sim_seed_order(p_cuit text, p_np_esperados int, p_metodo text, p_source text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_cod text := '99999'; v_dir text := 'SIM-'||p_cuit; v_tanda text := 'SIM'||substr(p_cuit,6);
        v_np text; v_nps text[] := '{}'; i int;
begin
  if p_cuit is null or p_cuit not like '30999%' then raise exception 'solo cuit de simulacion'; end if;
  insert into public.wa_sim_control(cuit,fecha,np_esperados,business_name,metodo,cod_cliente,direccion,tanda,source)
  values (p_cuit,current_date,p_np_esperados,'CLIENTE SIMULACIÓN',p_metodo,v_cod,v_dir,v_tanda,coalesce(p_source,'lk'))
  on conflict (cuit,fecha) do update set np_esperados=excluded.np_esperados, metodo=excluded.metodo,
    source=excluded.source, direccion=excluded.direccion, tanda=excluded.tanda;
  for i in 1..p_np_esperados loop
    v_np := '9990'||substr(p_cuit,6)||i::text; v_nps := array_append(v_nps, v_np);
    insert into public."PPP_Programacion_Diaria"(np,cod,tanda,tipo,fecha_recep,razon_social,m3,direccion,zona,fecha_entrega)
    values (v_np,v_cod,v_tanda,'SIM',to_char(current_date,'YYYY-MM-DD'),'CLIENTE SIMULACIÓN',1.0,v_dir,'SIM',to_char(current_date+1,'YYYY-MM-DD'));
    insert into public.wa_np_snapshot(np,cod_cliente,razon_social,direccion,sucursal_entrega,metodo_pago,first_seen)
    values (v_np,v_cod,'CLIENTE SIMULACIÓN',v_dir,null,p_metodo,now()) on conflict (np) do nothing;
  end loop;
  update public.wa_sim_control set np_list=v_nps where cuit=p_cuit and fecha=current_date;
  return jsonb_build_object('cuit',p_cuit,'cod',v_cod,'direccion',v_dir,'tanda',v_tanda,'nps',v_nps);
end $$;

-- ── Driver: facturar una NP (dispara el trigger real de grupo completo). Idempotente. ──
create or replace function public.wa_sim_factura_np(p_cuit text, p_np text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_cod text; v_tanda text;
begin
  if p_cuit not like '30999%' or p_np not like '9990%' then raise exception 'solo datos de simulacion'; end if;
  select cod_cliente, tanda into v_cod, v_tanda from public.wa_sim_control where cuit=p_cuit and fecha=current_date;
  insert into public."Facturacion_NP"(np,tanda,cod_cliente,razon_social,fecha_salida,facturado_at,m3)
  select p_np,coalesce(v_tanda,'SIM'),v_cod,'CLIENTE SIMULACIÓN',current_date,now(),1.0
  where not exists (select 1 from public."Facturacion_NP" f where f.np = p_np);
end $$;

-- ── Driver: insertar documento (factura parseada) en isis_lk / isis_ch ──
create or replace function public.wa_sim_insert_documento(
  p_source text, p_cuit text, p_fecha date, p_numero text, p_total numeric, p_subt numeric,
  p_condicion text, p_nombre text, p_storage_path text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_schema text; v_id text;
begin
  if p_cuit is null or p_cuit not like '30999%' then raise exception 'solo cuit de simulacion'; end if;
  v_schema := case p_source when 'ch' then 'isis_ch' else 'isis_lk' end;
  execute format($f$insert into %I.documentos
    (tipo,familia,letra,punto_venta,numero,fecha,contraparte_cuit,contraparte_nombre,condicion_venta,
     total,subt_gravado,storage_path,confianza,totales_ok,archivo_nombre,datos)
    values ('FC','factura_venta','A','0004',$1,$2,$3,$4,$5,$6,$7,$8,'alta',true,$9,'{"_sim":"1"}'::jsonb)
    returning comprobante_id$f$, v_schema)
  into v_id using p_numero,p_fecha,p_cuit,p_nombre,p_condicion,p_total,p_subt,p_storage_path,'sim_'||p_numero||'.pdf';
  return v_id;
end $$;

-- ── Limpieza: paths de PDFs + borrado total de datos de prueba ──
create or replace function public.wa_sim_paths()
returns text[] language sql security definer set search_path to 'public' as $$
  select coalesce(array_agg(sp),'{}') from (
    select storage_path sp from isis_lk.documentos where contraparte_cuit like '30999%'
    union all select storage_path from isis_ch.documentos where contraparte_cuit like '30999%') x where sp is not null;
$$;
create or replace function public.wa_sim_cleanup_all()
returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  delete from isis_lk.documentos where contraparte_cuit like '30999%';
  delete from isis_ch.documentos where contraparte_cuit like '30999%';
  delete from public."Facturacion_NP" where cod_cliente='99999' or np like '9990%';
  delete from public."PPP_Programacion_Diaria" where cod='99999' or direccion like 'SIM-%';
  delete from public.wa_np_snapshot where cod_cliente='99999' or direccion like 'SIM-%';
  delete from public.wa_grupo_listo where cod_cliente='99999';
  delete from public.wa_sim_control where cuit like '30999%';
  get diagnostics n = row_count;
  return n;
end $$;
