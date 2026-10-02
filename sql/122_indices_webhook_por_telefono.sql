-- 122 — Índices del camino caliente del bot (auditoría de performance, 02/10/2026)
--
-- Medido en producción el 02/10 (pg_stat_user_tables / pg_stat_user_indexes). Ninguno cambia datos ni políticas.
--
--   1. wa_inbound_seen (1.359 filas; índices: pkey(wamid) y (first_seen)). El webhook la consulta por `phone` + rango
--      de `first_seen` hasta tres veces por mensaje (saludo suelto, ráfaga de pedido, mensaje posterior) → seq scan.
--      Crece una fila por mensaje recibido y hoy nadie la poda (wa_inbound_seen_limpiar existe, sql/057, sin cron).
--   2. wa_alertas_humano (830 filas; índices: pkey, (tipo, created_at), parcial estado='pendiente'). El webhook la
--      consulta por `phone` (+ motivo + fecha) en cuatro lugares: descarte por whitelist (una vez por día y teléfono),
--      cliente molesto (2 h), pedido por archivo (24 h), aviso a Cobranzas. 12.928 seq scans. El dashboard
--      (lk_conversaciones, lk_fallas-mail) la lee con `estado in ('pendiente','notificado')`: el parcial sólo cubre
--      'pendiente' y no se usa (1 scan en total).
--   3. wa_outbox (109 filas). La deduplicación de avisos busca `context = X and ref_id = Y` en 12 lugares (sql/078,
--      079, 082-085, 105, 106, 108, 110 y lk_recordatorio-descuento): corre en el INSERT de cada pedido web, en cada
--      cambio de order_tracking y en 3 crons. Sin índice.
--   4. wa_clientes_telefono (792 filas). `idx_wa_clientes_telefono_norm` (sql/010) indexa wa_normalize_phone(telefono),
--      pero wa_identify_customer compara right(wa_normalize_phone(telefono), 10) desde sql/073: 0 usos del índice
--      en todo su historial (pg_stat_user_indexes). Se reemplaza por la expresión que la función usa de verdad.
--      wa_identify_customer corre en CADA mensaje entrante.
--   5. bot_token_usage (654 filas; tabla de PaginaLK, ninguna migración de este repo la crea ni creó ese primer índice).
--      `bot_token_usage_created_at` e `idx_bot_token_usage_created` (sql/107) son el mismo índice (created_at desc): se
--      saca el menos usado (112 vs 854 scans); el `if exists` lo hace inocuo donde no esté. _shared/llm.ts consulta `model + created_at`
--      tres veces antes de cada llamada a un modelo de la cadena (cuotas): se le da su índice.
--
-- Hoy son tablas chicas y el seq scan cuesta poco: los índices son para que el costo no crezca con el uso. Idempotente.
--
-- ESTADO DE APLICACIÓN (02/10/2026): los 6 `create index` están aplicados en producción (verificado en pg_indexes). Los 2
-- `drop index` NO: el MCP de Supabase retiene toda sentencia destructiva esperando confirmación y en una sesión no
-- interactiva eso termina en timeout (apply_migration se colgó 2 veces; los CREATE solos entraron al instante). Son dos
-- índices redundantes, no rotos: dejarlos cuesta un poco en cada escritura y nada más. Correr los dos `drop` a mano
-- cuando Pablo lo confirme; el archivo entero sigue siendo idempotente.

-- 1
create index if not exists wa_inbound_seen_phone_first_seen_idx
  on public.wa_inbound_seen (phone, first_seen desc);

-- 2
create index if not exists wa_alertas_humano_phone_created_idx
  on public.wa_alertas_humano (phone, created_at desc);
create index if not exists wa_alertas_humano_abiertas_idx
  on public.wa_alertas_humano (created_at desc)
  where estado in ('pendiente', 'notificado');

-- 3
create index if not exists wa_outbox_context_ref_idx
  on public.wa_outbox (context, ref_id);

-- 4 (wa_normalize_phone es IMMUTABLE: ya sostenía el índice de expresión de sql/010)
create index if not exists wa_clientes_telefono_tel10_idx
  on public.wa_clientes_telefono (right(wa_normalize_phone(telefono), 10));
drop index if exists public.idx_wa_clientes_telefono_norm;

-- 5
drop index if exists public.bot_token_usage_created_at;
create index if not exists bot_token_usage_model_created_idx
  on public.bot_token_usage (model, created_at desc);

-- ROLLBACK
--   drop index if exists public.wa_inbound_seen_phone_first_seen_idx;
--   drop index if exists public.wa_alertas_humano_phone_created_idx;
--   drop index if exists public.wa_alertas_humano_abiertas_idx;
--   drop index if exists public.wa_outbox_context_ref_idx;
--   drop index if exists public.wa_clientes_telefono_tel10_idx;
--   create index if not exists idx_wa_clientes_telefono_norm on public.wa_clientes_telefono (wa_normalize_phone(telefono));
--   drop index if exists public.bot_token_usage_model_created_idx;
--   create index if not exists bot_token_usage_created_at on public.bot_token_usage (created_at desc);
