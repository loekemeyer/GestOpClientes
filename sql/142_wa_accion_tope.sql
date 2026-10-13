-- 142 · wa_accion_tope — topes por acción y por número (Pablo Olejavetzky, 13/10/2026, riesgo 3 de la constitución)
--
-- El tope de 20/h (wa_check_rate_limit) cuenta CONSULTAS. Esto limita las ACCIONES que le dan trabajo a una
-- persona o cargan algo (derivar_a_persona, solicitar_agregado_pedido, solicitar_nueva_sucursal, armar_pedido,
-- confirmar_pedido), para que un cliente o un loop del teléfono no inunde al equipo. Los límites por acción
-- están en _shared/tope-accion.ts; acá vive el contador.
--
-- bot_accion_tope(phone, accion, limite): cuenta las filas de esa acción y ese número en la última hora; si ya
-- llegó al límite devuelve false (no registra), y si no, inserta y devuelve true. El chequeo lo hace el webhook
-- antes de ejecutar la acción. SECURITY DEFINER, revocada de anon/authenticated.
--
-- Idempotente. Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicada el 13/10/2026.
-- Las filas son transitorias (sólo importan las de la última hora); una limpieza periódica es opcional.

create table if not exists public.wa_accion_tope (
  id bigint generated always as identity primary key,
  phone text not null,
  accion text not null,
  creado_en timestamptz not null default now()
);
create index if not exists wa_accion_tope_idx on public.wa_accion_tope (phone, accion, creado_en);
alter table public.wa_accion_tope enable row level security;  -- sin políticas = sólo service_role

create or replace function public.bot_accion_tope(p_phone text, p_accion text, p_limite integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare c integer;
begin
  select count(*) into c from public.wa_accion_tope
   where phone = p_phone and accion = p_accion and creado_en > now() - interval '1 hour';
  if c >= p_limite then
    return false;
  end if;
  insert into public.wa_accion_tope (phone, accion) values (p_phone, p_accion);
  return true;
end;
$$;

revoke all on function public.bot_accion_tope(text, text, integer) from anon, authenticated;
