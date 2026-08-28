-- gp_wa_np_snapshot.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- PROBLEMA: PPP_Programacion_Diaria es una tabla DEL DÍA (se reemplaza a diario).
-- La dirección de entrega de cada NP solo existe mientras la NP está viva en la PPP;
-- una vez entregada/facturada, rota y se pierde. vista_np_sucursal (sucursal_entrega)
-- tiene la misma cobertura efímera (~solo hoy).
--
-- Pero la dirección de entrega es lo que distingue DOS pedidos distintos del mismo
-- cliente el mismo día que van a lugares diferentes. Para poder agrupar por
-- cliente+dirección de forma FORWARD-FACING hay que congelar la dirección el día que
-- la NP está viva.
--
-- SOLUCIÓN: snapshot persistente. wa_np_snapshot_run() copia (idempotente) las NPs
-- vivas de hoy en wa_np_snapshot. Se corre 1 vez por día (dormant: no hay cron todavía,
-- se dispara manualmente o desde el pipeline cuando se active). El histórico solo crece
-- hacia adelante; el backlog viejo no se puede recuperar (la dirección ya rotó).

create table if not exists public.wa_np_snapshot (
  np                text primary key,
  cod_cliente       text,
  razon_social      text,
  direccion         text,
  barrio            text,
  zona              text,
  sucursal_entrega  text,
  metodo_pago       text,
  first_seen        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

grant select on public.wa_np_snapshot to anon, authenticated, service_role;

-- Congela las NPs vivas de la PPP de hoy. Idempotente: la primera captura fija first_seen
-- (dirección del día real); relecturas solo refrescan campos sin pisar first_seen.
create or replace function public.wa_np_snapshot_run()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into public.wa_np_snapshot as s
    (np, cod_cliente, razon_social, direccion, barrio, zona, sucursal_entrega, metodo_pago)
  select
    p.np,
    p.cod,
    p.razon_social,
    nullif(btrim(p.direccion), ''),
    nullif(btrim(p.barrio), ''),
    nullif(btrim(p.zona), ''),
    v.sucursal_entrega,
    v.metodo_pago
  from public."PPP_Programacion_Diaria" p
  left join public.vista_np_sucursal v on v.np = p.np
  where p.np ~ '^[0-9]+$'
  on conflict (np) do update set
    -- refresca solo si el snapshot previo estaba vacío (no pisar el dato del día original)
    direccion        = coalesce(s.direccion, excluded.direccion),
    barrio           = coalesce(s.barrio, excluded.barrio),
    zona             = coalesce(s.zona, excluded.zona),
    sucursal_entrega = coalesce(s.sucursal_entrega, excluded.sucursal_entrega),
    metodo_pago      = coalesce(s.metodo_pago, excluded.metodo_pago),
    razon_social     = coalesce(s.razon_social, excluded.razon_social),
    updated_at       = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.wa_np_snapshot_run() to service_role;
