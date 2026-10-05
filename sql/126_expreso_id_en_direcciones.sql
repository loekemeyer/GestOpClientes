-- 126 — expreso_id en customer_delivery_addresses: la dirección de entrega guarda la LLAVE al maestro, no sólo el nombre (Pablo Olejavetzky, 05/10/2026)
--
-- Hasta hoy el expreso de una dirección es TEXTO (`nombre_expreso`, `direccion_expreso`). El código vive sólo en
-- `public.expresos` (412 filas, carga única del 30/04/2026) y el vínculo se hace por nombre. Con nombre repetido en el
-- maestro (9 nombres: Cruz del Sur 060/324, Interprovincial 114/385, Transvel 450/451, y seis con la misma dirección dos
-- veces) el código no se puede saber. `expreso_pendiente.expreso_id` ya usa esta llave (id del maestro); esto la lleva a
-- la dirección.
--
-- ⚠ Se enlaza por `expresos.id`, NO por `codigo`: así no depende de que `codigo` sea el código de ISIS (sin verificar al 05/10).
-- ⚠ NULL = "no resuelto", no "sin expreso": nombre repetido sin dirección que desempate, nombre fuera del maestro, o sin expreso.
-- ⚠ «Retira» está en el maestro (id 412, código 999, "Virgilio 2788"): queda enlazado como cualquier otro expreso.
--
-- Una sola regla (`expreso_id_de`) para el backfill y para el trigger, porque dos copias de la misma regla terminan divergiendo.
-- El trigger es lo que evita que la columna quede vieja: la dirección la escriben `expreso_cambiar`, `expo_guardar_cliente`,
-- `lk_alertas` y la página directo por REST (políticas delivery_write_*), y ninguno conoce la columna nueva.
--
-- Medido en seco el 05/10/2026 sobre las 1.623 direcciones: 973 se completan (950 únicos por nombre, 137 de ellos «Retira»,
-- y 23 repetidos resueltos por dirección); 30 con nombre quedan NULL (12 repetidos ambiguos, 18 fuera del maestro) y 620 no
-- tienen expreso cargado. Sin triggers, publicaciones realtime ni `updated_at` previos en la tabla: el backfill no despierta
-- nada. Las vistas gv_cliente_isis_calc, gv_web_sucursal_sin_match y v_pedidos_web no cambian (columna nueva al final).
-- No toca `pending_isis`. No llega a Gestión: `gv-sync-padron-direcciones` pide columnas por nombre.
--
-- Idempotente: se puede correr dos veces.
--
-- ESTADO (05/10/2026): NO APLICADA. Preparada; espera el "sí" de Pablo.

-- 1) La columna. `on delete set null`: si algún día se depura el maestro, la dirección queda "no resuelta" en vez de trabarse.
alter table public.customer_delivery_addresses
  add column if not exists expreso_id bigint references public.expresos(id) on delete set null;

comment on column public.customer_delivery_addresses.expreso_id is
  'id de public.expresos. Se completa solo desde nombre_expreso (+ direccion_expreso si el nombre está repetido en el maestro). NULL = no resuelto (sin expreso, fuera del maestro o repetido ambiguo). Lo mantiene el trigger cda_expreso_id.';

-- 2) La regla de resolución. Nombre único en el maestro → ese id. Nombre repetido → el que coincide con la dirección del
--    expreso ("domicilio, localidad", con o sin ", provincia" al final); si coinciden dos o ninguno → NULL.
--    Invoker (no security definer): `expresos` se lee con la política expresos_read_all (todos los roles).
create or replace function public.expreso_id_de(p_nombre text, p_direccion text)
returns bigint
language sql
stable
set search_path = public
as $$
  with n as (
    select upper(btrim(regexp_replace(coalesce(p_nombre,''),'\s+',' ','g'))) nom,
           regexp_replace(lower(translate(coalesce(p_direccion,''),'áéíóúñÁÉÍÓÚÑ','aeiounaeioun')),'[^a-z0-9]','','g') dir
  ), c as (
    select e.id,
           (k.ke <> '' and left(n.dir, length(k.ke)) = k.ke) dir_ok
      from n, public.expresos e,
           lateral (select regexp_replace(lower(translate(coalesce(e.domicilio,'')||coalesce(e.localidad,''),'áéíóúñÁÉÍÓÚÑ','aeiounaeioun')),'[^a-z0-9]','','g') ke) k
     where n.nom <> ''
       and upper(btrim(regexp_replace(e.razon_social,'\s+',' ','g'))) = n.nom
  )
  select case when (select count(*) from c) = 1 then (select id from c)
              when (select count(*) from c where dir_ok) = 1 then (select id from c where dir_ok)
         end
$$;

-- 3) El trigger. Recalcula expreso_id sólo cuando cambia el nombre o la dirección del expreso y quien escribe no puso
--    expreso_id a mano (así un desempate manual de los 12 ambiguos se respeta, y escribir sólo expreso_id no lo pisa).
create or replace function public.trg_cda_expreso_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.expreso_id is null then
      new.expreso_id := public.expreso_id_de(new.nombre_expreso, new.direccion_expreso);
    end if;
  elsif (new.nombre_expreso is distinct from old.nombre_expreso
         or new.direccion_expreso is distinct from old.direccion_expreso)
        and new.expreso_id is not distinct from old.expreso_id then
    new.expreso_id := public.expreso_id_de(new.nombre_expreso, new.direccion_expreso);
  end if;
  return new;
end $$;

drop trigger if exists cda_expreso_id on public.customer_delivery_addresses;
create trigger cda_expreso_id
  before insert or update of nombre_expreso, direccion_expreso on public.customer_delivery_addresses
  for each row execute function public.trg_cda_expreso_id();

-- 4) El backfill. Sólo completa lo que quedó NULL y sólo si la regla resuelve; no pisa nada y no dispara el trigger
--    (no toca nombre_expreso ni direccion_expreso).
update public.customer_delivery_addresses d
   set expreso_id = public.expreso_id_de(d.nombre_expreso, d.direccion_expreso)
 where d.expreso_id is null
   and btrim(coalesce(d.nombre_expreso,'')) <> ''
   and public.expreso_id_de(d.nombre_expreso, d.direccion_expreso) is not null;

-- Verificación (correr después de aplicar):
--   select count(*) filter (where expreso_id is not null)                                         con_id,           -- esperado 973
--          count(*) filter (where btrim(coalesce(nombre_expreso,''))<>'' and expreso_id is null)  con_nombre_sin_id, -- esperado 30
--          count(*)                                                                               total             -- esperado 1.623
--     from public.customer_delivery_addresses;
--   -- el id enlazado tiene que ser el mismo expreso que el nombre (esperado 0 filas):
--   select d.customer_id, d.slot, d.nombre_expreso, e.razon_social
--     from public.customer_delivery_addresses d join public.expresos e on e.id = d.expreso_id
--    where upper(btrim(regexp_replace(e.razon_social,'\s+',' ','g'))) <> upper(btrim(regexp_replace(d.nombre_expreso,'\s+',' ','g')));

-- Reversa (la columna sola no rompe nada si se queda; el orden importa porque el trigger usa la función):
--   drop trigger if exists cda_expreso_id on public.customer_delivery_addresses;
--   drop function if exists public.trg_cda_expreso_id();
--   drop function if exists public.expreso_id_de(text, text);
--   alter table public.customer_delivery_addresses drop column if exists expreso_id;
