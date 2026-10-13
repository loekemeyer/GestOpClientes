-- 140 — Lo que el bot mandó en la charla, con el wamid de Meta, y lo que Meta rechazó DESPUÉS de aceptar
-- (Pablo Olejavetzky, 13/10/2026: plan docs/PLAN-AGENTE-8-PUNTOS-2026-10-13.md, punto P6 "revisar el resultado").
--
-- Caso que lo motivó (08/10, Damián de Chef 411): el bot le dijo «¡Listo! Te mandé la foto» 5 veces y las 5 volvieron
-- `failed` en wa_message_status (131053). Meta acepta el POST y rechaza después, por el webhook de estados, así que el
-- código que mandó ya terminó y nadie se enteraba salvo el mail de fallas. El agente tampoco: en el turno siguiente
-- repetía «ya te la mandé».
--
-- Qué hace:
--   1. wa_envios_bot: una fila por mensaje que el bot manda en la charla (texto, foto, archivo o plantilla), con el
--      wamid que devuelve Meta. La escribe _shared/wa-api.ts (waPost) en cada POST aceptado, así cubre TODAS las
--      salidas (webhook, chat de prueba, cola). Hasta acá sólo la cola guardaba el wamid (wa_outbox.wamid, sql/081):
--      las respuestas del bot y las fotos no tenían cómo cruzarse con su estado.
--   2. Trigger en wa_message_status: cuando llega un `failed` de un wamid de wa_envios_bot,
--        a) marca la fila (fallo_codigo, fallo_detalle, fallo_en),
--        b) escribe en bot_auditoria una fila `envio_no_llego` → _shared/hechos-charla.ts la muestra al agente en el
--           turno siguiente («NO le llegó la foto «505 — …» (Meta lo rechazó, código 131053)») y la regla del bloque
--           le dice que no diga que se lo mandó ni lo reenvíe por su cuenta,
--        c) deja una alerta (motivo envio_fallido, una por teléfono cada 30 min) para que una persona lo vea en
--           Tareas. Los avisos al equipo (plantillas aviso_equipo*) no dejan alerta: ya los cubre el mail de fallas.
-- Idempotente. Rollback: sql/rollback/140_wa_envios_bot_rechazados_por_meta.sql.

create table if not exists public.wa_envios_bot (
  wamid         text primary key,
  telefono      text not null,
  tipo          text not null default 'otro',   -- text | image | document | template | otro
  descripcion   text not null default '',       -- cómo se lo nombra al agente: «la foto «505 — Pelador…»», «el archivo «Factura.pdf»»
  plantilla     text,                           -- nombre de la plantilla si tipo = template
  creado_en     timestamptz not null default now(),
  fallo_codigo  integer,
  fallo_detalle text,
  fallo_en      timestamptz
);
alter table public.wa_envios_bot enable row level security;   -- sin políticas: sólo service_role
create index if not exists wa_envios_bot_telefono_idx on public.wa_envios_bot (telefono, creado_en desc);

create or replace function public.trg_wa_envio_fallido() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  e   public.wa_envios_bot%rowtype;
  cod integer;
  det text;
  ya  integer;
begin
  if new.status <> 'failed' then return new; end if;
  begin
    cod := nullif(new.errors->0->>'code', '')::integer;
  exception when others then
    cod := null;
  end;
  det := left(coalesce(nullif(new.errors->0->>'title', ''), nullif(new.errors->0->>'message', ''), 'sin detalle'), 200);

  update public.wa_envios_bot
     set fallo_codigo = cod, fallo_detalle = det, fallo_en = coalesce(new.ts, now())
   where wamid = new.wamid and fallo_en is null
  returning * into e;
  if not found then return new; end if;

  -- b) lo ve el agente en "Hechos de esta charla" (bot_auditoria, 24 h)
  insert into public.bot_auditoria (telefono, tool_usado, parametros, resultado_resumen)
  values (e.telefono, 'envio_no_llego',
          jsonb_build_object('wamid', e.wamid, 'tipo', e.tipo, 'descripcion', e.descripcion, 'plantilla', e.plantilla, 'codigo', cod),
          left('Meta lo rechazó después de aceptarlo: ' || coalesce(cod::text, '?') || ' ' || det, 500));

  -- c) lo ve una persona: una alerta por teléfono cada 30 min; los avisos al equipo no (ya van en el mail de fallas)
  if coalesce(e.plantilla, '') not like 'aviso_equipo%' then
    select count(*) into ya from public.wa_alertas_humano
     where phone = e.telefono and contexto->>'motivo' = 'envio_fallido' and created_at > now() - interval '30 minutes';
    if ya = 0 then
      insert into public.wa_alertas_humano (tipo, phone, contexto)
      values ('otro', e.telefono, jsonb_build_object(
        'motivo', 'envio_fallido',
        'texto', format('No le llegó %s: Meta lo rechazó después de aceptarlo (%s, código %s). El bot pudo haberle dicho que se lo mandó.',
                        e.descripcion, det, coalesce(cod::text, '?')),
        'wamid', e.wamid, 'tipo', e.tipo, 'descripcion', e.descripcion, 'codigo', cod, 'detalle', det,
        'origen', 'trigger wa_envio_fallido', 'urgente', false));
    end if;
  end if;
  return new;
exception when others then
  raise warning 'trg_wa_envio_fallido: % (wamid %)', sqlerrm, new.wamid;
  return new;
end $$;

drop trigger if exists wa_envio_fallido on public.wa_message_status;
create trigger wa_envio_fallido
  after insert on public.wa_message_status
  for each row when (new.status = 'failed')
  execute function public.trg_wa_envio_fallido();

comment on table public.wa_envios_bot is
  'Cada mensaje que el bot mandó (wamid de Meta) y, si Meta lo rechazó después de aceptarlo, el código y cuándo. sql/140.';
