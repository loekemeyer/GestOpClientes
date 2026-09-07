-- 058 — RLS en las tablas del agente (punto 3 de la auditoría del 2026-09-07)
--
-- EL PROBLEMA
-- ===========
-- Las cinco tablas `wa_agente_*` quedaron afuera de `sql/056` porque el dashboard las leía y
-- las escribía **directo con la anon key**. Y la anon key es pública: viaja en
-- `docs/index.html`, servido por GitHub Pages.
--
-- Estado antes de esta migración, medido:
--
--   tabla                      rls     anon podía
--   wa_agente_config           false   SELECT, INSERT, UPDATE, DELETE, TRUNCATE, …
--   wa_agente_config_history   false   idem
--   wa_agente_consultas        false   idem
--   wa_agente_evals            false   idem
--   wa_agente_modelos          false   idem
--
-- Lo grave no es perder filas —son tablas chicas—: **`wa_agente_config` es el documento rector
-- del agente**. Cualquiera con la anon key podía reescribir el prompt del bot y hacerle decir
-- lo que quisiera a los clientes. Es prompt injection persistida, servida por nosotros.
--
-- CÓMO QUEDA
-- ==========
-- El corte es por dato, no por tabla:
--
--   · **Escrituras**: ninguna desde `anon`. Todas pasan por la Edge Function
--     `lk_agente-modelos`, que exige rol admin server-side (acciones `config_save`,
--     `consulta_responder`, `consulta_descartar`, `eval_add`, `eval_save`, `eval_delete`,
--     `modelos_prioridad`). El front las llama con el helper `agente()`.
--   · **Lecturas**: siguen directo por PostgREST en las cuatro tablas que NO tienen datos de
--     cliente (config, historial, evals, modelos) — es lo que el panel dibuja, y sacarlo por la
--     función sería ruido sin ganancia.
--   · **`wa_agente_consultas` no**: son preguntas escritas por clientes reales. Ahí ni la
--     lectura sale con la anon key; va por la acción `consultas_list`.
--
-- `wa_agente_model_keys` ya tenía RLS (ahí viven las API keys) y no se toca.
--
-- ORDEN DE PUESTA EN MARCHA (importa)
-- ===================================
-- Esta migración y el deploy del front/función van **juntos**. Aplicar el SQL con el front
-- viejo deja los botones de guardar muertos; deployar el front nuevo sin el SQL funciona pero
-- deja la puerta vieja abierta. Se mergea todo en el mismo commit.
--
-- ROLLBACK
--   alter table public.wa_agente_config          disable row level security;
--   alter table public.wa_agente_config_history  disable row level security;
--   alter table public.wa_agente_consultas       disable row level security;
--   alter table public.wa_agente_evals           disable row level security;
--   alter table public.wa_agente_modelos         disable row level security;
--   grant all on public.wa_agente_config, public.wa_agente_config_history,
--                public.wa_agente_consultas, public.wa_agente_evals,
--                public.wa_agente_modelos to anon;

-- ── 1) RLS prendida en las cinco ──────────────────────────────────────────────────────────
alter table public.wa_agente_config          enable row level security;
alter table public.wa_agente_config_history  enable row level security;
alter table public.wa_agente_consultas       enable row level security;
alter table public.wa_agente_evals           enable row level security;
alter table public.wa_agente_modelos         enable row level security;

-- ── 2) Lectura para el panel, sólo donde no hay datos de cliente ──────────────────────────
drop policy if exists wa_agente_config_lectura         on public.wa_agente_config;
drop policy if exists wa_agente_config_hist_lectura    on public.wa_agente_config_history;
drop policy if exists wa_agente_evals_lectura          on public.wa_agente_evals;
drop policy if exists wa_agente_modelos_lectura        on public.wa_agente_modelos;

create policy wa_agente_config_lectura      on public.wa_agente_config         for select to anon, authenticated using (true);
create policy wa_agente_config_hist_lectura on public.wa_agente_config_history for select to anon, authenticated using (true);
create policy wa_agente_evals_lectura       on public.wa_agente_evals          for select to anon, authenticated using (true);
create policy wa_agente_modelos_lectura     on public.wa_agente_modelos        for select to anon, authenticated using (true);

-- `wa_agente_consultas` a propósito SIN policy: sólo `service_role`, que saltea la RLS.

-- ── 3) Sacarle a anon todo lo que no sea leer ─────────────────────────────────────────────
-- La RLS sin esto ya alcanzaría, pero un grant de más es una trampa esperando a que alguien
-- agregue una policy permisiva sin mirar.
revoke insert, update, delete, truncate, references, trigger
  on public.wa_agente_config, public.wa_agente_config_history, public.wa_agente_consultas,
     public.wa_agente_evals, public.wa_agente_modelos
  from anon, authenticated;

revoke select on public.wa_agente_consultas from anon, authenticated;

grant select on public.wa_agente_config, public.wa_agente_config_history,
                public.wa_agente_evals, public.wa_agente_modelos
  to anon, authenticated;

comment on table public.wa_agente_config is
  'Documento rector del agente. Se ESCRIBE sólo por lk_agente-modelos (action config_save), que '
  'exige admin. La anon key es pública: nunca reabrir un grant de escritura acá.';
