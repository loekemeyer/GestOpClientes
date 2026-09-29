-- 101: puntaje de las respuestas de la IA (Pablo, 29/09).
-- Cada respuesta del agente IA al cliente queda acá (lo inserta lk_whatsapp-webhook). Cada 10 minutos
-- lk_ia-puntaje la hace evaluar por Haiku con 5 criterios de 1 a 5:
--   correcta (los datos son ciertos según lo que devolvieron las herramientas), resolvio (contestó lo que preguntó),
--   derivo (derivó cuando correspondía y no cuando no), reglas (respetó las reglas fijas del agente), tono.
-- minimo <= 2 → aparece en la lista de revisión del dashboard (IA › Revisión de respuestas).
-- El gasto de Haiku se registra en bot_token_usage con function_name = 'lk_ia-puntaje'.
create table if not exists public.wa_ia_puntajes (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  phone text,
  customer_id uuid,
  pregunta text not null,
  respuesta text not null,
  herramientas jsonb not null default '[]'::jsonb,
  modelo_respuesta text,
  -- evaluación
  evaluado_at timestamptz,
  intentos smallint not null default 0,
  correcta smallint check (correcta between 1 and 5),
  resolvio smallint check (resolvio between 1 and 5),
  derivo smallint check (derivo between 1 and 5),
  reglas smallint check (reglas between 1 and 5),
  tono smallint check (tono between 1 and 5),
  minimo smallint generated always as (least(correcta, resolvio, derivo, reglas, tono)) stored,
  comentario text,
  -- revisión humana
  revision text check (revision in ('bien_marcada', 'falsa_alarma')),
  revisado_por text,
  revisado_at timestamptz,
  nota_revision text
);
alter table public.wa_ia_puntajes enable row level security;   -- sin políticas: sólo service_role
create index if not exists wa_ia_puntajes_pendientes on public.wa_ia_puntajes (created_at) where evaluado_at is null;
create index if not exists wa_ia_puntajes_revisar on public.wa_ia_puntajes (created_at desc) where minimo <= 2 and revision is null;

select cron.schedule('lk_ia-puntaje', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_ia-puntaje',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-lk-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'LK_FN_CRON_SECRET' order by created_at desc limit 1)),
    body := '{"action":"evaluar"}'::jsonb, timeout_milliseconds := 60000);
$$);
