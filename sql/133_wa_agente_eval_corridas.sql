-- 133 — Corrida automática de los casos de evaluación del agente (wa_agente_evals) en el Simulador, con aviso de cambios.
-- Pablo Olejavetzky, 08/10/2026 ("qué le falta para ser un agente": que se mida solo). El CI ya corre las pruebas de código
-- (tests/, desde el 08/10). Lo que no se corría solo eran los casos del agente: había que apretar "Simular" uno por uno en el Panel.
--
-- Cómo anda:
--   • wa_eval_corrida_nueva(origen) arma una corrida con todos los casos activos que se pueden simular (sin "no_simular").
--     La dispara el cron lk_eval-corrida a las 03:15 (hora Argentina) y se puede disparar a mano: select wa_eval_corrida_nueva('manual').
--   • wa_eval_tick(), cada minuto (cron lk_eval-tick): recoge la respuesta del caso que estaba en el Simulador y manda el siguiente.
--     De a UN caso por minuto: el plan gratis de Gemini da 15 solicitudes por minuto y un turno usa hasta 3 (medido el 05/10).
--     Un error de la IA (503, timeout) se reintenta hasta 2 veces más.
--   • Al terminar compara cada caso con la corrida anterior y marca qué cambió: camino (respuesta fija ↔ IA ↔ otra), deriva
--     (a quién lo pasa), texto (sólo respuestas fijas sin datos, full_auto: las que traen datos cambian solas) y error. Lo que
--     contesta la IA NO se compara letra por letra: cambia en cada corrida.
--   • El aviso: lk_fallas-mail suma la corrida con cambios o errores al mail de fallas, y el Panel la muestra en Evaluación.
--
-- GASTO US$ 0, y no puede gastar: antes de mandar cada caso, wa_eval_modelos_gratis() exige que TODOS los modelos de
-- app_settings.llm_modelo_pruebas estén en wa_agente_modelos activos y con is_free_tier. Si alguien dejó Haiku (regla del 07/10)
-- o un modelo que el Simulador no reconoce (lo trataría como de Anthropic), la corrida espera, y a las 6 horas se corta.
-- No crea alertas ni tareas (crear_tareas = false) ni toca respuesta_bot / respuesta_via de wa_agente_evals: eso es lo que
-- revisó una persona en el Panel, y queda como está.

create table if not exists public.wa_agente_eval_corridas (
  id           bigserial primary key,
  origen       text not null default 'manual',      -- cron | manual
  estado       text not null default 'corriendo',   -- corriendo | terminada | cortada | sin_modelo_gratis
  modelos      text,                                 -- llm_modelo_pruebas al arrancar
  anterior_id  bigint references public.wa_agente_eval_corridas(id),
  casos        int not null default 0,
  hechos       int not null default 0,
  errores      int not null default 0,
  cambios      int not null default 0,
  creada_at    timestamptz not null default now(),
  terminada_at timestamptz
);

create table if not exists public.wa_agente_eval_resultados (
  id           bigserial primary key,
  corrida_id   bigint not null references public.wa_agente_eval_corridas(id) on delete cascade,
  eval_id      bigint not null references public.wa_agente_evals(id) on delete cascade,
  estado       text not null default 'pendiente',   -- pendiente | enviado | listo | error
  intentos     int not null default 0,
  request_id   bigint,
  enviado_at   timestamptz,
  via          text,                                 -- tal cual lo devuelve lk_bot-simular
  camino       text,                                 -- fija #N | ia | otro (cliente_molesto, respuesta_aviso…)
  deriva       text,                                 -- motivos de las alertas, o 'no'
  herramientas text[],
  respuesta    text,
  error        text,
  antes        jsonb,                                -- el mismo caso en la corrida anterior
  cambios      text[],                               -- camino | deriva | texto | error
  listo_at     timestamptz,
  unique (corrida_id, eval_id)
);
create index if not exists wa_agente_eval_resultados_estado on public.wa_agente_eval_resultados (corrida_id, estado);

-- Respuestas simuladas con un cliente real: sólo service_role (la lee lk_agente-modelos, que exige admin).
alter table public.wa_agente_eval_corridas enable row level security;
alter table public.wa_agente_eval_resultados enable row level security;
revoke all on table public.wa_agente_eval_corridas, public.wa_agente_eval_resultados from anon, authenticated;
revoke all on sequence public.wa_agente_eval_corridas_id_seq, public.wa_agente_eval_resultados_id_seq from anon, authenticated;

-- ¿Todos los modelos de prueba son gratis? Sin lista, o con uno que no está activo y gratis en wa_agente_modelos: no.
create or replace function public.wa_eval_modelos_gratis() returns boolean
language sql stable security definer set search_path = public as $$
  with l as (
    select btrim(x) as m
      from public.app_settings s, unnest(string_to_array(s.value, ',')) x
     where s.key = 'llm_modelo_pruebas' and btrim(x) <> ''
  )
  select exists (select 1 from l)
     and not exists (
       select 1 from l
        where not exists (select 1 from public.wa_agente_modelos w where w.model_id = l.m and w.is_free_tier and w.activo));
$$;

create or replace function public.wa_eval_corrida_nueva(p_origen text default 'manual') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_modelos text;
begin
  select id into v_id from public.wa_agente_eval_corridas where estado = 'corriendo' order by id desc limit 1;
  if v_id is not null then return v_id; end if;   -- una sola a la vez
  select value into v_modelos from public.app_settings where key = 'llm_modelo_pruebas';
  if not public.wa_eval_modelos_gratis() then
    insert into public.wa_agente_eval_corridas (origen, estado, modelos, terminada_at)
    values (p_origen, 'sin_modelo_gratis', v_modelos, now()) returning id into v_id;
    return v_id;
  end if;
  insert into public.wa_agente_eval_corridas (origen, modelos) values (p_origen, v_modelos) returning id into v_id;
  insert into public.wa_agente_eval_resultados (corrida_id, eval_id)
  select v_id, e.id
    from public.wa_agente_evals e
   where coalesce(e.activo, true) and btrim(coalesce(e.pregunta, '')) <> ''
     and not (coalesce(e.simulacion, '{}'::jsonb) ? 'no_simular')
   order by e.orden nulls last, e.id;
  update public.wa_agente_eval_corridas
     set casos = (select count(*) from public.wa_agente_eval_resultados where corrida_id = v_id)
   where id = v_id;
  return v_id;
end $$;

create or replace function public.wa_eval_tick() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_c       record;
  r         record;
  p         record;
  v_status  int;
  v_timeout boolean;
  v_errmsg  text;
  v_content text;
  v_charla  jsonb;
  v_via     text;
  v_err     text;
  v_body    jsonb;
  v_req     bigint;
  v_prev    bigint;
begin
  select * into v_c from public.wa_agente_eval_corridas where estado = 'corriendo' order by id limit 1;
  if v_c.id is null then return 'sin corrida'; end if;

  -- 1) Recoger lo que contestó el Simulador.
  for r in select * from public.wa_agente_eval_resultados where corrida_id = v_c.id and estado = 'enviado' loop
    select h.status_code, h.timed_out, h.error_msg, h.content
      into v_status, v_timeout, v_errmsg, v_content
      from net._http_response h where h.id = r.request_id;
    if not found then
      if r.enviado_at < now() - interval '5 minutes' then
        update public.wa_agente_eval_resultados
           set estado = case when intentos < 2 then 'pendiente' else 'error' end, intentos = intentos + 1,
               error = 'el Simulador no contestó en 5 minutos', request_id = null
         where id = r.id;
      end if;
      continue;
    end if;
    v_err := null; v_charla := null; v_via := null;
    if coalesce(v_timeout, false) or v_status is distinct from 200 then
      v_err := coalesce(v_errmsg, 'HTTP ' || coalesce(v_status::text, '?'));
    else
      begin
        v_charla := (v_content::jsonb) -> 'charla' -> 0;
      exception when others then v_err := 'respuesta ilegible';
      end;
      if v_err is null and v_charla is null then v_err := coalesce(left((v_content::jsonb) ->> 'error', 300), 'sin charla'); end if;
    end if;
    if v_err is null then
      v_via := v_charla ->> 'via';
      -- "agente (timeout…)" / "agente (error…)": la IA no contestó (Gemini 503, por ejemplo). Se reintenta.
      if v_via like 'agente (%' then v_err := left(coalesce(v_charla ->> 'bot', v_via), 300); end if;
    end if;
    if v_err is not null then
      update public.wa_agente_eval_resultados
         set estado = case when intentos < 2 then 'pendiente' else 'error' end, intentos = intentos + 1,
             error = v_err, request_id = null, via = v_via
       where id = r.id;
      continue;
    end if;
    update public.wa_agente_eval_resultados set
      estado = 'listo', listo_at = now(), error = null, via = v_via,
      camino = case when v_via like 'faq%' then 'fija' || coalesce(' #' || substring(v_via from '#(\d+)'), '')
                    when v_via like 'agente IA%' then 'ia'
                    else coalesce(v_via, '?') end,
      deriva = coalesce((select string_agg(distinct coalesce(a ->> 'motivo', a ->> 'tipo', 'persona'), ', '
                                                 order by coalesce(a ->> 'motivo', a ->> 'tipo', 'persona'))
                           from jsonb_array_elements(coalesce(v_charla -> 'alertas', '[]'::jsonb)) a), 'no'),
      herramientas = (select array_agg(distinct h ->> 'nombre')
                        from jsonb_array_elements(coalesce(v_charla -> 'herramientas', '[]'::jsonb)) h),
      respuesta = v_charla ->> 'bot'
     where id = r.id;
  end loop;

  -- 2) Mandar el siguiente (de a uno: si hay uno en el Simulador, se espera).
  if not exists (select 1 from public.wa_agente_eval_resultados where corrida_id = v_c.id and estado = 'enviado') then
    select res.id, e.pregunta, e.simulacion into p
      from public.wa_agente_eval_resultados res join public.wa_agente_evals e on e.id = res.eval_id
     where res.corrida_id = v_c.id and res.estado = 'pendiente'
     order by res.id limit 1;
    if found then
      if public.wa_eval_modelos_gratis() then   -- nunca gastar: si el modelo de pruebas no es gratis, espera
        v_body := (coalesce(nullif(p.simulacion, 'null'::jsonb), '{"cod_cliente": 4210}'::jsonb) - 'no_simular')
                  || jsonb_build_object('pasos', jsonb_build_array(jsonb_build_object('cliente', p.pregunta)), 'crear_tareas', false);
        v_req := net.http_post(
          url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_bot-simular',
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-lk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'LK_FN_CRON_SECRET'
                            order by created_at desc limit 1)),
          body := v_body,
          timeout_milliseconds := 120000);
        update public.wa_agente_eval_resultados set estado = 'enviado', request_id = v_req, enviado_at = now() where id = p.id;
        return 'mandado ' || p.id;
      end if;
    end if;
  end if;

  -- 3) ¿Terminó (o pasaron 6 horas)? Comparar con la corrida anterior y cerrar.
  if exists (select 1 from public.wa_agente_eval_resultados where corrida_id = v_c.id and estado in ('pendiente', 'enviado'))
     and v_c.creada_at > now() - interval '6 hours' then
    return 'esperando';
  end if;
  update public.wa_agente_eval_resultados
     set estado = 'error', error = coalesce(error, 'la corrida se cortó a las 6 horas')
   where corrida_id = v_c.id and estado in ('pendiente', 'enviado');
  select id into v_prev from public.wa_agente_eval_corridas
   where estado in ('terminada', 'cortada') and id < v_c.id order by id desc limit 1;
  if v_prev is not null then
    update public.wa_agente_eval_resultados x set
      antes = jsonb_build_object('estado', a.estado, 'camino', a.camino, 'deriva', a.deriva, 'respuesta', a.respuesta),
      cambios = array_remove(array[
        case when a.estado = 'listo' and x.estado = 'listo' and a.camino is distinct from x.camino then 'camino' end,
        case when a.estado = 'listo' and x.estado = 'listo' and a.deriva is distinct from x.deriva then 'deriva' end,
        case when a.estado = 'listo' and x.estado = 'listo' and a.camino = x.camino
              and a.via like '%full_auto%' and x.via like '%full_auto%' and a.respuesta is distinct from x.respuesta then 'texto' end,
        case when a.estado = 'listo' and x.estado = 'error' then 'error' end
      ], null)
      from public.wa_agente_eval_resultados a
     where x.corrida_id = v_c.id and a.corrida_id = v_prev and a.eval_id = x.eval_id;
  end if;
  update public.wa_agente_eval_corridas c set
    estado = case when c.creada_at > now() - interval '6 hours' then 'terminada' else 'cortada' end,
    terminada_at = now(), anterior_id = v_prev,
    hechos  = (select count(*) from public.wa_agente_eval_resultados where corrida_id = c.id and estado = 'listo'),
    errores = (select count(*) from public.wa_agente_eval_resultados where corrida_id = c.id and estado = 'error'),
    cambios = (select count(*) from public.wa_agente_eval_resultados where corrida_id = c.id and cardinality(cambios) > 0)
   where c.id = v_c.id;
  return 'terminada ' || v_c.id;
end $$;

revoke all on function public.wa_eval_modelos_gratis(), public.wa_eval_corrida_nueva(text), public.wa_eval_tick() from public, anon, authenticated;
-- El botón "Correr ahora" del Panel la llama por lk_agente-modelos (exige admin).
grant execute on function public.wa_eval_corrida_nueva(text) to service_role;

-- Crons (idempotente: cron.schedule con el mismo nombre reemplaza el job).
select cron.schedule('lk_eval-corrida', '15 6 * * *', $$select public.wa_eval_corrida_nueva('cron')$$);   -- 03:15 Argentina
select cron.schedule('lk_eval-tick', '* * * * *', $$select public.wa_eval_tick()$$);
