-- 134 — Corrida de evaluación: un caso que falló se reintenta al FINAL de la cola, no enseguida.
-- Pablo Olejavetzky, 08/10/2026. En la primera corrida (id 1) el caso 3 dio timeout de Gemini 3 veces seguidas en 3 minutos: el
-- reintento volvía a salir primero (orden por id) y Gemini todavía no se había recuperado. Ahora se ordena por intentos y después por id.
-- Sólo cambia esa línea de wa_eval_tick (sql/133).

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

revoke all on function public.wa_eval_tick() from public, anon, authenticated;
