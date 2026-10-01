-- 117 — Evaluación del agente: los casos del estudio de consultas por WhatsApp, con la respuesta del bot y su corrección
-- Pedido de Pablo Olejavetzky (01/10): "armalo en el dashboard". Reemplaza el Excel "Respuestas bot por causa" y el
-- artifact del mismo nombre: los ejemplos de cada causa y tipo de mensaje viven en wa_agente_evals (pestaña Evaluación),
-- el admin vuelve a simular cada uno desde el panel y deja la respuesta corregida acá.
--
-- Sólo agrega columnas: los casos cargados a mano (pregunta + nota_esperada) siguen igual.
--   clave              'm<n>' mensaje de Aperturas, 'r<n>' ejemplo por causa; NULL en los casos a mano.
--   origen             de dónde sale el caso (p. ej. 'estudio_whatsapp_2026').
--   causa, tipo, metodo, num, orden, consultas
--                      agrupación y peso del caso: consultas = cuántas consultas reales representa
--                      (clientes con código, 01/01–09/06/2026; en los 'r' es la base 28/07–28/09).
--   simulacion         cómo se simula: {"cod_cliente":4210} | {"numero_nuevo":true} | {"no_simular":"<motivo>"}.
--   respuesta_bot, respuesta_via, respuesta_deriva, simulado_at
--                      la última respuesta del bot (la escribe lk_agente-modelos eval_resultado).
--   obs_claude         observación de la revisión.
--   respuesta_corregida, corregido_por, corregido_at
--                      lo que debería contestar el bot (lk_agente-modelos eval_corregir; corregido_por = email admin).
--   estado             pendiente → corregida (hay corrección) → aplicada (ya está en el bot).
-- Escritura: sólo lk_agente-modelos (exige admin). La lectura pasa a ser sólo por la edge function en sql/118.

alter table public.wa_agente_evals
  add column if not exists clave               text,
  add column if not exists origen              text,
  add column if not exists causa               text,
  add column if not exists tipo                text,
  add column if not exists metodo              text,
  add column if not exists num                 text,
  add column if not exists orden               int,
  add column if not exists consultas           int,
  add column if not exists simulacion          jsonb,
  add column if not exists respuesta_bot       text,
  add column if not exists respuesta_via       text,
  add column if not exists respuesta_deriva    text,
  add column if not exists simulado_at         timestamptz,
  add column if not exists obs_claude          text,
  add column if not exists respuesta_corregida text,
  add column if not exists corregido_por       text,
  add column if not exists corregido_at        timestamptz,
  add column if not exists estado              text not null default 'pendiente';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wa_agente_evals_estado_chk') then
    alter table public.wa_agente_evals add constraint wa_agente_evals_estado_chk
      check (estado in ('pendiente', 'corregida', 'aplicada'));
  end if;
end $$;

create unique index if not exists wa_agente_evals_clave_uq on public.wa_agente_evals (clave) where clave is not null;
