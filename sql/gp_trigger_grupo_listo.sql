-- gp_trigger_grupo_listo.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- GATILLO (dejado DESACTIVADO) que detecta cuándo un grupo de pedido quedó COMPLETO:
-- cuando se factura la ÚLTIMA NP de un mismo cliente a un mismo destino en el día.
--
-- Grupo = cod_cliente + destino de entrega + día (del snapshot wa_np_snapshot, que
-- congela la dirección el día que la NP está viva). "Completo" = todas las NPs esperadas
-- de ese grupo (las que están en el snapshot) ya aparecen facturadas en Facturacion_NP.
--
-- NO envía ni combina nada: solo deja una fila en wa_grupo_listo (cola). El sender real
-- (futuro) leerá esa cola. El trigger se crea DESACTIVADO; se enciende recién cuando se
-- decida prender el bot:  alter table public."Facturacion_NP" enable trigger wa_np_facturado_trg;

-- Cola de grupos completos, listos para consolidar+enviar (cuando exista el sender).
create table if not exists public.wa_grupo_listo (
  grupo_key     text primary key,          -- cod_cliente | destino_norm | dia
  cod_cliente   text,
  razon_social  text,
  destino       text,
  dia           date,
  nps           text[],
  n_nps         integer,
  detectado_at  timestamptz not null default now(),
  enviado       boolean not null default false,
  enviado_at    timestamptz
);
grant select on public.wa_grupo_listo to anon, authenticated, service_role;

-- Normalizador de destino (misma regla que vista_grupo_pedido).
create or replace function public.wa_destino_norm(p_sucursal text, p_direccion text)
returns text language sql immutable as $$
  select coalesce(nullif(btrim(p_sucursal), ''),
                  nullif(upper(btrim(p_direccion)), ''),
                  '(s/dir)');
$$;

-- Chequea si el grupo de la NP recién facturada quedó completo; si sí, encola.
create or replace function public.wa_grupo_completo_check(p_np text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cod text; v_dest text; v_dia date; v_rs text;
  v_esperadas text[]; v_faltan int;
begin
  -- Datos del grupo desde el snapshot (destino congelado el día de la NP).
  select s.cod_cliente,
         public.wa_destino_norm(s.sucursal_entrega, s.direccion),
         s.first_seen::date,
         s.razon_social
    into v_cod, v_dest, v_dia, v_rs
  from public.wa_np_snapshot s
  where s.np = p_np;

  if v_cod is null then
    return false;  -- NP sin snapshot (histórico previo al snapshot) -> no se puede agrupar
  end if;

  -- NPs esperadas del grupo (todas las del snapshot con mismo cliente+destino+día).
  select array_agg(s.np order by s.np)
    into v_esperadas
  from public.wa_np_snapshot s
  where s.cod_cliente = v_cod
    and public.wa_destino_norm(s.sucursal_entrega, s.direccion) = v_dest
    and s.first_seen::date = v_dia;

  -- ¿Cuántas de las esperadas NO están todavía en Facturacion_NP?
  select count(*)
    into v_faltan
  from unnest(v_esperadas) e(np)
  where not exists (select 1 from public."Facturacion_NP" f where f.np = e.np);

  if v_faltan > 0 then
    return false;  -- todavía falta facturar alguna NP del grupo
  end if;

  -- Grupo completo -> encolar (idempotente).
  insert into public.wa_grupo_listo(grupo_key, cod_cliente, razon_social, destino, dia, nps, n_nps)
  values (v_cod || '|' || v_dest || '|' || v_dia::text, v_cod, v_rs, v_dest, v_dia,
          v_esperadas, coalesce(array_length(v_esperadas,1),0))
  on conflict (grupo_key) do update set
    nps = excluded.nps, n_nps = excluded.n_nps, razon_social = excluded.razon_social;
  return true;
end;
$$;

-- Trigger AFTER INSERT: nunca debe romper la facturación -> atrapa cualquier error.
create or replace function public.wa_np_facturado_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.wa_grupo_completo_check(NEW.np);
  exception when others then
    null;  -- no bloquear el insert de Facturacion_NP por un fallo del chequeo
  end;
  return NEW;
end;
$$;

drop trigger if exists wa_np_facturado_trg on public."Facturacion_NP";
create trigger wa_np_facturado_trg
  after insert on public."Facturacion_NP"
  for each row execute function public.wa_np_facturado_trg();

-- DEJARLO DESACTIVADO hasta encender el bot.
alter table public."Facturacion_NP" disable trigger wa_np_facturado_trg;

-- Para encender (cuando esté todo listo):
--   alter table public."Facturacion_NP" enable trigger wa_np_facturado_trg;
