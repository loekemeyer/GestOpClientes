-- 155 — Tope de gasto de IA POR CLIENTE (Pablo Olejavetzky, 14/10/2026: "el tope va a ser 2 USD por cliente por día, 5 USD por semana"). Segunda de las
-- dos capas; la primera es el medidor mensual del pozo (sql/154). Esta SÍ corta, pero sólo al cliente que se dispara: a los demás el agente les sigue
-- contestando. Lógica pura en _shared/tope-cliente.ts, enganche en lk_whatsapp-webhook (pasoElTopeCliente).
--
-- Los dos números se pisan a propósito (se lo marqué a Pablo, los dejó así): con US$ 2/día pero US$ 5/semana, 3 días llenos (US$ 6) ya pasan la semana,
-- así que el semanal corta antes en casi todos los casos; el diario queda como sub-límite para una explosión en un solo día.
--
-- Se cambia sin deploy desde acá:
--   UPDATE public.app_settings SET value = '2' WHERE key = 'ia_tope_cliente_dia_usd';     -- tope por cliente por día (0 apaga el diario)
--   UPDATE public.app_settings SET value = '5' WHERE key = 'ia_tope_cliente_semana_usd';  -- tope por cliente por semana (0 apaga el semanal)
-- Los dos en 0 apagan la capa entera.

insert into public.app_settings (key, value) values
  ('ia_tope_cliente_dia_usd',    '2'),
  ('ia_tope_cliente_semana_usd', '5')
on conflict (key) do nothing;

-- El tope lee el gasto de UN teléfono en una ventana (día/semana): índice por (phone, created_at) para no escanear toda bot_token_usage. El índice por
-- created_at solo lo dejó sql/107; éste agrega el teléfono adelante para esta consulta.
create index if not exists bot_token_usage_phone_created on public.bot_token_usage (phone, created_at desc);

-- Verificación:
--   select key, value from public.app_settings where key like 'ia_tope_cliente_%' order by key;
