-- ISIS (Control Partes Talleristas / hrxfctzncixxqmpfhskv) — objetos del simulador
-- de avisos por facturación. NO aplicar en PaginaLK. Ya está aplicado en ISIS.
--
-- Aislación total: todo actúa sólo sobre facturas de PRUEBA (CUIT ficticio 30999… +
-- marcador datos->>'_sim'='1'). Ningún documento real matchea. El simulador del
-- dashboard (edge function lk_notif-sim en PaginaLK) usa estas piezas vía RPC pública
-- porque el schema isis_lk no está expuesto por PostgREST.

-- ── Tablas de control/cola (schema public de ISIS) ──
create table if not exists public.wa_sim_control (
  sim_id        uuid primary key default gen_random_uuid(),
  cuit          text not null,
  fecha         date not null,
  np_esperados  integer not null default 1,
  business_name text,
  metodo        text not null default 'no_decidido',
  created_at    timestamptz not null default now(),
  unique (cuit, fecha)
);
create table if not exists public.wa_sim_avisos (
  id           bigint generated always as identity primary key,
  cuit         text not null,
  fecha        date not null,
  n_facturas   integer not null default 0,
  ready_at     timestamptz not null default now(),
  processed_at timestamptz,
  unique (cuit, fecha)
);
alter table public.wa_sim_control enable row level security;  -- sólo service_role
alter table public.wa_sim_avisos  enable row level security;

-- ── Trigger real: al impactar una factura de PRUEBA en isis_lk.documentos, si el
--    grupo (cuit+fecha) ya tiene todas las facturas esperadas, encola el aviso. ──
create or replace function public.wa_sim_documentos_notify()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_exp int; v_cnt int;
begin
  if coalesce(new.datos->>'_sim','') <> '1' then return new; end if;
  select np_esperados into v_exp from public.wa_sim_control
   where cuit = new.contraparte_cuit and fecha = new.fecha order by created_at desc limit 1;
  if v_exp is null then return new; end if;
  select count(*) into v_cnt from isis_lk.documentos d
   where coalesce(d.datos->>'_sim','')='1' and d.contraparte_cuit = new.contraparte_cuit
     and d.fecha = new.fecha and d.familia='factura_venta';
  if v_cnt >= v_exp then
    insert into public.wa_sim_avisos (cuit, fecha, n_facturas, ready_at)
    values (new.contraparte_cuit, new.fecha, v_cnt, now())
    on conflict (cuit, fecha) do update set n_facturas = excluded.n_facturas;
  end if;
  return new;
exception when others then raise warning 'wa_sim_documentos_notify: %', sqlerrm; return new;
end $$;

drop trigger if exists wa_sim_documentos_trg on isis_lk.documentos;
create trigger wa_sim_documentos_trg
  after insert on isis_lk.documentos
  for each row when (coalesce(new.datos->>'_sim','') = '1')
  execute function public.wa_sim_documentos_notify();

-- ── RPCs públicas (isis_lk no expuesto). Todas gateadas al CUIT 30999… ──
create or replace function public.wa_sim_insert_documento(
  p_cuit text, p_fecha date, p_numero text, p_total numeric, p_subt numeric,
  p_condicion text, p_nombre text, p_storage_path text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_id text;
begin
  if p_cuit is null or p_cuit not like '30999%' then
    raise exception 'wa_sim_insert_documento: solo CUIT de simulacion (30999...)';
  end if;
  insert into isis_lk.documentos
    (tipo, familia, letra, punto_venta, numero, fecha, contraparte_cuit, contraparte_nombre,
     condicion_venta, total, subt_gravado, storage_path, confianza, totales_ok, archivo_nombre, datos)
  values ('FC','factura_venta','A','0004', p_numero, p_fecha, p_cuit, p_nombre,
     p_condicion, p_total, p_subt, p_storage_path, 'alta', true, 'sim_'||p_numero||'.pdf', '{"_sim":"1"}'::jsonb)
  returning comprobante_id into v_id;
  return v_id;
end $$;

create or replace function public.wa_sim_paths()
returns text[] language sql security definer set search_path to 'public' as $$
  select coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}')
  from isis_lk.documentos where contraparte_cuit like '30999%';
$$;

create or replace function public.wa_sim_cleanup()
returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  delete from isis_lk.documentos where contraparte_cuit like '30999%';
  get diagnostics n = row_count;
  delete from public.wa_sim_avisos  where cuit like '30999%';
  delete from public.wa_sim_control where cuit like '30999%';
  return n;
end $$;
