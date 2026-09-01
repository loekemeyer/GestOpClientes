-- 048_wa_comprobantes.sql
-- Recepción y parseo de comprobantes de pago enviados por WhatsApp.
--
-- Piezas:
--   1) Bucket privado 'wa-comprobantes' en Supabase Storage
--      (paths: {cod_cliente_o_phone}/{YYYY-MM}/{wamid}.{ext})
--   2) Tabla wa_comprobantes: 1 fila por archivo recibido, incluye datos
--      parseados por IA y estado del flujo (pending → parsed → matched → confirmed).
--   3) Columna wa_agente_modelos.tarea: permite tener cadenas de modelos
--      separadas por tarea (default 'general' para el chat, 'parse_comprobante'
--      para el parser de comprobantes). Idempotente vía IF NOT EXISTS.
--   4) Seed de modelos para parse_comprobante: Haiku 4.5 (primary) + Gemini 2.5 Flash (fallback free tier).
--
-- Nota RLS: los buckets privados de Supabase solo permiten acceso vía service_role
-- key o signed URLs. Las Edge Functions usan service_role (SUPABASE_SERVICE_ROLE_KEY);
-- para exposición al dashboard usamos signed URLs con TTL 7 días desde la Edge Function.

-- ── 1) Bucket ─────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wa-comprobantes', 'wa-comprobantes', false,
  20971520, -- 20 MB máx por archivo
  array['image/jpeg','image/png','image/webp','application/pdf']
) on conflict (id) do nothing;

-- ── 2) Tabla wa_comprobantes ──────────────────────────────────────────
create table if not exists wa_comprobantes (
  id                uuid primary key default gen_random_uuid(),
  -- Origen
  wamid             text unique,             -- id del mensaje WA (msg.image.id / msg.document.id / etc.)
  phone             text not null,
  cod_cliente       text,                    -- resuelto con wa_identify_customer al recibir
  caption           text,                    -- caption opcional del mensaje WA
  -- Archivo en storage
  storage_bucket    text not null default 'wa-comprobantes',
  storage_path      text not null,           -- key dentro del bucket
  mime_type         text,
  size_bytes        integer,
  downloaded_at     timestamptz not null default now(),
  -- Parseo por IA
  parsed_at         timestamptz,
  parse_provider    text,                    -- 'anthropic:claude-haiku-4-5' | 'google:gemini-2.5-flash' | 'manual'
  parse_model_id    bigint references wa_agente_modelos(id),
  parse_confidence  numeric,                 -- 0-1
  parse_raw         jsonb,                   -- respuesta completa del modelo
  -- Datos extraídos (subset estable — el resto queda en parse_raw)
  es_comprobante    boolean,                 -- true = el modelo cree que es comprobante
  tipo              text,                    -- transferencia|mercadopago|cheque|deposito|pos|qr|otro
  monto_total       numeric,                 -- valor OBLIGATORIO cuando es_comprobante=true (base del matcheo)
  moneda            text default 'ARS',      -- ARS|USD|OTRA
  fecha_operacion   date,
  -- Matcheo con factura/ND/NC (resuelto en un paso posterior)
  matched_doc_tipo  text,                    -- 'factura'|'nd'|'nc'
  matched_doc_id    text,                    -- id/número del comprobante en el sistema
  matched_at        timestamptz,
  matched_by        text,                    -- 'auto' | usuario
  -- Estado
  status            text not null default 'pending'
                    check (status in ('pending','parsed','matched','confirmed','rejected','no_comprobante','error')),
  ultimo_error      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists wa_comprobantes_phone_idx on wa_comprobantes(phone);
create index if not exists wa_comprobantes_cod_cliente_idx on wa_comprobantes(cod_cliente);
create index if not exists wa_comprobantes_status_idx on wa_comprobantes(status);
create index if not exists wa_comprobantes_created_at_idx on wa_comprobantes(created_at desc);

-- Trigger updated_at
create or replace function wa_comprobantes_touch_updated() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
drop trigger if exists wa_comprobantes_updated_at on wa_comprobantes;
create trigger wa_comprobantes_updated_at
  before update on wa_comprobantes
  for each row execute function wa_comprobantes_touch_updated();

-- ── 3) Columna tarea en wa_agente_modelos ─────────────────────────────
alter table wa_agente_modelos
  add column if not exists tarea text not null default 'general';

create index if not exists wa_agente_modelos_tarea_idx on wa_agente_modelos(tarea, prioridad);

-- ── 4) Seed de modelos para parse_comprobante ─────────────────────────
-- Idempotente: solo inserta si no hay filas con esa tarea.
-- La selección de "primario" dentro de una tarea usa prioridad ASC (no es_default,
-- que tiene un UNIQUE global reservado para la cadena 'general' del chat).
do $$
begin
  if not exists (select 1 from wa_agente_modelos where tarea = 'parse_comprobante') then
    insert into wa_agente_modelos
      (proveedor, label, model_id, tarea, prioridad, activo, es_default, is_free_tier, secret_ref, notas)
    values
      ('anthropic','Haiku 4.5 (vision)','claude-haiku-4-5','parse_comprobante',10,true,false,false,'ANTHROPIC_API_KEY',
       'Parser primario de comprobantes. Vision + JSON estructurado. ~$0.001-0.003 por comprobante.'),
      ('google','Gemini 2.5 Flash (vision, free tier)','gemini-2.5-flash','parse_comprobante',20,true,false,true,'GOOGLE_API_KEY',
       'Fallback gratuito. 250 RPD / 10 RPM. Vision + JSON. Usar si Haiku falla o entra en cooldown.');
  end if;
end $$;

comment on table wa_comprobantes is
  'Comprobantes de pago recibidos por WhatsApp: archivo en storage + datos parseados por IA + matcheo con factura/ND/NC.';
