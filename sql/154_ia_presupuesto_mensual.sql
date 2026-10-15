-- 154 — Presupuesto MENSUAL global de gasto de IA (Pablo Olejavetzky, 14/10/2026: "200 USD gratis de Anthropic, uso 100 USD mensuales, que avise
-- al 25, 50 y 75 por ciento, y verlo en el dashboard"). Decidido con él: las dos capas (ésta + el tope por cliente) y, al 100%, "sólo avisa".
--
-- Esto es SÓLO un medidor con avisos: no corta nada (el corte real son el tope diario de sql anterior y el tope por cliente). Cuenta TODO el gasto del
-- mes (clientes + simulador + chat de prueba + puntaje), porque el crédito de Anthropic se agota con todo. Lógica pura en _shared/presupuesto-ia.ts,
-- enganche en lk_whatsapp-webhook (avisarPresupuesto), vista en el dashboard (docs/index.html, sección IA).
--
-- Los avisos salen sobre estimated_cost_usd (el estimativo del código): es una aproximación, la corrección contra el Admin API de Anthropic queda como
-- paso aparte (necesita una admin key nueva). Se cambia sin deploy desde el Panel / acá:
--   UPDATE public.app_settings SET value = '100'          WHERE key = 'ia_presup_mensual_usd';  -- presupuesto del mes (0 apaga todo)
--   UPDATE public.app_settings SET value = '200'          WHERE key = 'ia_presup_pozo_usd';     -- pozo total, sólo para mostrarlo (0 lo oculta)
--   UPDATE public.app_settings SET value = '25,50,75,90,100' WHERE key = 'ia_presup_umbrales';  -- a qué % avisa

insert into public.app_settings (key, value) values
  ('ia_presup_mensual_usd', '100'),
  ('ia_presup_pozo_usd',    '200'),
  ('ia_presup_umbrales',    '25,50,75,90,100')
on conflict (key) do nothing;

-- Índice para que la deduplicación del aviso (una por umbral por mes) y el tablero no escaneen toda wa_alertas_humano. El gasto del mes lo lee el
-- webhook sumando bot_token_usage (ya tiene índice por created_at en sql/107).
create index if not exists wa_alertas_humano_created_at on public.wa_alertas_humano (created_at desc);

-- Verificación:
--   select key, value from public.app_settings where key like 'ia_presup_%' order by key;
