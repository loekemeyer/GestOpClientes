-- 158 · registrar TODO cambio de la llave de envíos, venga de donde venga (Pablo Olejavetzky, 15/10/2026)
--
-- Problema: wa_llave_cambios (sql/080) estaba vacía. llave_set de lk_conversaciones sí inserta ahí, pero la
-- llave se cambió siempre por SQL directo (`update app_settings set value=... where key='wa_envio_automatico'`,
-- como documenta el CLAUDE.md para arrancar), que NO pasa por la edge y no deja registro. Sin ese registro, el
-- worklist de charlas a revisar no puede distinguir una charla sin respuesta por bot pausado de una falla real.
--
-- Solución: un TRIGGER sobre app_settings registra cada cambio real del valor de wa_envio_automatico, venga del
-- dashboard, del SQL editor o de cualquier código. El email/nombre del admin (camino dashboard) llega por GUC de
-- sesión que setea la RPC wa_llave_set en la MISMA transacción; por SQL directo queda `via='sql'` y el usuario de
-- Postgres. La edge pasa a llamar la RPC y deja de insertar a mano (si no, duplicaría).
--
-- Efecto en cadena: toda escritura de app_settings sobre esa key deja una fila; un valor fuera de ('0','prueba','1')
-- NO se registra ni se bloquea (guarda). La vista/worklist puede leer la línea de tiempo de la llave para marcar
-- ventanas de pausa. llaveEstado() (edge) ya lee wa_llave_cambios para "último cambio".
--
-- Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicado (es la definición viva).

alter table public.wa_llave_cambios add column if not exists via text;

create or replace function public.wa_llave_log() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_email  text := current_setting('app.llave_actor_email',  true);
  v_nombre text := current_setting('app.llave_actor_nombre', true);
begin
  -- sólo la llave de envíos, sólo cuando el valor cambia de verdad, sólo valores válidos (no bloquea otros).
  if new.key <> 'wa_envio_automatico' then return new; end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return new; end if;
  if new.value not in ('0', 'prueba', '1') then return new; end if;

  insert into public.wa_llave_cambios (modo_anterior, modo_nuevo, usuario, email, via)
  values (
    case when tg_op = 'UPDATE' then old.value else null end,
    new.value,
    coalesce(nullif(v_nombre, ''), 'SQL directo (' || current_user || ')'),
    nullif(v_email, ''),
    case when coalesce(nullif(v_email, ''), nullif(v_nombre, '')) is not null then 'edge' else 'sql' end
  );
  return new;
end $fn$;

drop trigger if exists trg_wa_llave_log on public.app_settings;
create trigger trg_wa_llave_log
  after insert or update of value on public.app_settings
  for each row when (new.key = 'wa_envio_automatico')
  execute function public.wa_llave_log();

-- La edge (llave_set) llama a esto en vez de insertar a mano: deja el actor por GUC para que el trigger lo lea
-- en la misma transacción, y actualiza la llave. Sólo service_role (la edge); el front no la toca directo.
create or replace function public.wa_llave_set(p_modo text, p_email text default null, p_usuario text default null)
returns text language plpgsql security definer set search_path to 'public' as $fn$
begin
  if p_modo not in ('0', 'prueba', '1') then raise exception 'modo inválido: %', p_modo; end if;
  perform set_config('app.llave_actor_email',  coalesce(p_email, ''),   true);
  perform set_config('app.llave_actor_nombre', coalesce(p_usuario, ''), true);
  update public.app_settings set value = p_modo where key = 'wa_envio_automatico';
  if not found then
    insert into public.app_settings (key, value) values ('wa_envio_automatico', p_modo);
  end if;
  return p_modo;
end $fn$;
revoke all on function public.wa_llave_set(text, text, text) from public, anon, authenticated;
