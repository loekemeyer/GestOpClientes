-- 143 · wa_ataque_entrada — señal de ataque en la entrada (Pablo Olejavetzky, 13/10/2026, riesgo 4 de la constitución)
--
-- En el texto del cliente, el webhook detecta patrones de alta precisión (inyección / extracción de prompt /
-- jailbreak / base64 largo; ver _shared/ataque-entrada.ts) y los registra acá. NO corta la respuesta: la barrera
-- real es el bloque de Seguridad del prompt, el canario y el filtro de salida. Esto sólo escala.
--
-- bot_ataque_entrada(phone, patron): registra el intento y cuenta los del número en las últimas 24 h. Devuelve
-- {n, alertar (n = 3), blacklistear (n >= 5)}. El webhook, con eso: a los 3 avisa a una persona (alerta
-- motivo 'ataque_entrada'); a los 5 mete el número en wa_blacklist. SECURITY DEFINER, revocada de anon/authenticated.
--
-- Idempotente. Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicada el 13/10/2026.
-- Las filas son transitorias (sólo importan las de las últimas 24 h); una limpieza periódica es opcional.

create table if not exists public.wa_ataque_entrada (
  id bigint generated always as identity primary key,
  phone text not null,
  patron text,
  creado_en timestamptz not null default now()
);
create index if not exists wa_ataque_entrada_idx on public.wa_ataque_entrada (phone, creado_en);
alter table public.wa_ataque_entrada enable row level security;  -- sin políticas = sólo service_role

create or replace function public.bot_ataque_entrada(p_phone text, p_patron text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare c integer;
begin
  insert into public.wa_ataque_entrada (phone, patron) values (p_phone, p_patron);
  select count(*) into c from public.wa_ataque_entrada
   where phone = p_phone and creado_en > now() - interval '24 hours';
  return jsonb_build_object('n', c, 'alertar', c = 3, 'blacklistear', c >= 5);
end;
$$;

revoke all on function public.bot_ataque_entrada(text, text) from anon, authenticated;
