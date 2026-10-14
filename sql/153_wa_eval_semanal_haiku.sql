-- 153 — Corrida semanal de evaluación con Haiku 5.5, el modelo del piloto (P5 del plan de los 8 puntos).
-- Pablo Olejavetzky, 14/10/2026: «Cambialo a Haiku, medición semanal». El criterio de P5 pasa de "3 noches seguidas con Gemini" a
-- "los casos de varios pasos pasan con Haiku en la medición semanal": Gemini Flash Lite fallaba casos que Haiku resolvía (mp03 y mp06).
-- Costo aprobado por Pablo: unos US$ 0,03 por corrida (8 casos a US$ 0,0037, medido el 14/10). Tope: cada caso se reintenta como mucho
-- 2 veces, así que una corrida no pasa de 24 turnos (unos US$ 0,09).
--
-- Cómo: la corrida guarda modelo_eval y solo_origen. wa_eval_tick le pide ese modelo al Simulador (body.modelo_eval) sin tocar
-- app_settings.llm_modelo_pruebas, y el Simulador sólo lo acepta desde una llamada interna y si está en MODELOS_EVAL_PAGOS
-- (supabase/functions/_shared/modelos-prueba.ts). La corrida nocturna (modelo_eval null) queda igual: nunca gasta.
-- Puede convivir con la nocturna: wa_eval_tick atiende la más vieja que esté corriendo y después la siguiente.
-- Rollback: sql/rollback/153_wa_eval_semanal_haiku.sql

alter table public.wa_agente_eval_corridas add column if not exists modelo_eval text;
alter table public.wa_agente_eval_corridas add column if not exists solo_origen text;

create or replace function public.wa_eval_corrida_modelo(p_modelo text default 'claude-haiku-5-5', p_solo_origen text default 'multipaso',
                                                         p_origen text default 'cron_semanal') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  if p_modelo is distinct from 'claude-haiku-5-5' then
    raise exception 'modelo no permitido para la corrida paga: %', p_modelo;
  end if;
  select id into v_id from public.wa_agente_eval_corridas
   where estado = 'corriendo' and modelo_eval = p_modelo and solo_origen is not distinct from p_solo_origen order by id desc limit 1;
  if v_id is not null then return v_id; end if;   -- una sola de este tipo a la vez
  insert into public.wa_agente_eval_corridas (origen, modelos, modelo_eval, solo_origen)
  values (p_origen, p_modelo, p_modelo, p_solo_origen) returning id into v_id;
  insert into public.wa_agente_eval_resultados (corrida_id, eval_id)
  select v_id, e.id
    from public.wa_agente_evals e
   where coalesce(e.activo, true) and btrim(coalesce(e.pregunta, '')) <> ''
     and not (coalesce(e.simulacion, '{}'::jsonb) ? 'no_simular')
     and (p_solo_origen is null or e.origen = p_solo_origen)
   order by e.orden nulls last, e.id;
  update public.wa_agente_eval_corridas
     set casos = (select count(*) from public.wa_agente_eval_resultados where corrida_id = v_id)
   where id = v_id;
  return v_id;
end $$;

revoke all on function public.wa_eval_corrida_modelo(text, text, text) from public, anon, authenticated;

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
     order by res.intentos, res.id limit 1;   -- 134: un reintento va después de los que no se probaron
    if found then
      -- 153: la corrida semanal (modelo_eval) paga a sabiendas con el modelo del piloto. La nocturna sigue sin gastar nunca.
      if v_c.modelo_eval = 'claude-haiku-5-5' or (v_c.modelo_eval is null and public.wa_eval_modelos_gratis()) then
        v_body := (coalesce(nullif(p.simulacion, 'null'::jsonb), '{"cod_cliente": 4210}'::jsonb) - 'no_simular')
                  || jsonb_build_object('pasos', jsonb_build_array(jsonb_build_object('cliente', p.pregunta)), 'crear_tareas', false)
                  || case when v_c.modelo_eval is null then jsonb_build_object('solo_gratis', true)   -- 135: el Simulador descarta todo modelo pago
                          else jsonb_build_object('modelo_eval', v_c.modelo_eval) end;
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
  -- 153: se compara con la anterior del MISMO tipo (la semanal con Haiku contra la semanal anterior, la nocturna contra la nocturna).
  select id into v_prev from public.wa_agente_eval_corridas
   where estado in ('terminada', 'cortada') and id < v_c.id
     and modelo_eval is not distinct from v_c.modelo_eval and solo_origen is not distinct from v_c.solo_origen
   order by id desc limit 1;
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

revoke all on function public.wa_eval_tick() from public, anon, authenticated;

-- Lunes 10:15 de Argentina (13:15 UTC): lejos de la nocturna de las 03:15, que con 111 casos termina en unas 2 horas.
select cron.schedule('lk_eval-semanal-haiku', '15 13 * * 1', $cron$select public.wa_eval_corrida_modelo('claude-haiku-5-5', 'multipaso', 'cron_semanal')$cron$);
