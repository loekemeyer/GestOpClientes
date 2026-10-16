-- 161 — (APLICADA 16/10) Aviso de entrega/retiro para remitos NO-WEB (remito conforme sin pedido web).
-- Pedido de Pablo Olejavetzky (16/10): "Tiene que salir igual, haya pedido o no, si está el remito conforme
-- está entregado". Hay casos reales de remito sin pedido web (venta manual, ISIS, corrección). Cuando ese
-- remito se marca conforme (controlado en RR → evento CRN), el cliente tiene que recibir el aviso igual.
--
-- Reparto del trabajo:
--   * WEB (es_web=true, retira/reparto/expreso): ya lo cubre order_tracking + trg_order_tracking_notify (sql/160).
--   * NO-WEB (es_web=false): lo cubre ESTA vía nueva. No se pisan (order_tracking sólo tiene pedidos web).
--
-- Fuente: public.gv_remitos_controlados (Virgilio) tiene np, tipo (retirado/entregado), cod_cliente, es_web,
-- controlado_at, fecha. Problema de permisos: esa vista es security_invoker=true y su cadena
-- (gv_ppp_entregados, etc. también invoker) re-chequea contra el rol del FDW (lk_ppp_reader), que no tiene
-- SELECT en la cadena. Solución SIN abrir permisos en toda la cadena: una función SECURITY DEFINER (corre como
-- postgres, dueño que sí lee todo) + una vista fina que la llama, y GRANT sólo sobre esa vista.
--
-- Fecha del aviso ({{1}}): para no-web no hay fecha de pedido web; se usa la fecha de control/entrega del remito
-- (gv_remitos_controlados.fecha). PENDIENTE de revisar con Pablo antes de abrir la llave si esa fecha es la que
-- quiere en el texto "Tu pedido del {{1}}...". Hoy no sale nada a clientes reales: la vasectomía
-- (app_settings.wa_envio_automatico) sigue cortando; sólo la whitelist recibiría en 'prueba'.
--
-- Rollback: en PaginaLK, cron.unschedule('lk_aviso-remito-entregado') + drop function wa_avisos_remito_entregado()
-- + drop foreign table virgilio.gv_remitos_controlados_bot. En Virgilio, drop view gv_remitos_controlados_bot +
-- drop function gv_remitos_controlados_bot_f(). No se tocó ni borró nada preexistente.

-- ───────────────────────────── EN VIRGILIO (hrxfctzncixxqmpfhskv) ─────────────────────────────
-- Función SECURITY DEFINER (owner postgres) que expone el feed saltando la cadena invoker.
create or replace function public.gv_remitos_controlados_bot_f()
returns table(np text, empresa text, tipo text, controlado_at timestamptz, fecha date, cod_cliente text, es_web boolean)
language sql stable security definer set search_path to 'public'
as $fn$
  select np, empresa, tipo, controlado_at, fecha, cod_cliente, es_web
  from public.gv_remitos_controlados
$fn$;

-- Vista fina que llama a la función (es la que lee el FDW).
create or replace view public.gv_remitos_controlados_bot
  with (security_invoker=false) as
  select np, empresa, tipo, controlado_at, fecha, cod_cliente, es_web
  from public.gv_remitos_controlados_bot_f();

grant select on public.gv_remitos_controlados_bot to lk_ppp_reader;

comment on view public.gv_remitos_controlados_bot is
  'SENTINELA — creada por Claude (sesion session_01H69G85yP81jJRETaiZ9Kr5) el 2026-10-16 a pedido de Pablo '
  'Olejavetzky. Feed read-only para el bot WA de PaginaLK (lk_ppp_reader) de remitos controlados. Definer via '
  'funcion gv_remitos_controlados_bot_f() a proposito (evita abrir permisos en toda la cadena invoker). No romper '
  'ni borrar sin avisar. Ref repo GestOpClientes sql/161.';

-- ───────────────────────────── EN PAGINA LK (kwkclwhmoygunqmlegrg) ─────────────────────────────
-- Foreign table al feed.
create foreign table if not exists virgilio.gv_remitos_controlados_bot (
  np text, empresa text, tipo text,
  controlado_at timestamptz, fecha date, cod_cliente text, es_web boolean
) server virgilio_db options (schema_name 'public', table_name 'gv_remitos_controlados_bot');

-- Encolador de avisos para remitos NO-WEB controlados.
create or replace function public.wa_avisos_remito_entregado()
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_n int := 0; r record; v_tpl text;
begin
  for r in
    select g.np, g.tipo, g.cod_cliente, g.fecha, bcw.whatsapp as phone
    from virgilio.gv_remitos_controlados_bot g
    join lateral (
      select b.whatsapp from bot_customer_whatsapps b
      where b.cod_cliente = g.cod_cliente::int
      order by b.is_primary desc, b.created_at desc limit 1
    ) bcw on true
    where g.es_web = false
      and g.cod_cliente ~ '^[0-9]+$'
      and g.tipo in ('retirado','entregado')
      and g.controlado_at > now() - interval '2 days'
      and not exists (select 1 from wa_outbox w where w.context = 'remito_conforme' and w.ref_id = g.np)
  loop
    v_tpl := case when r.tipo = 'retirado' then 'pedido_retirado' else 'pedido_entregado' end;
    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, v_tpl, jsonb_build_object('1', coalesce(to_char(r.fecha,'DD/MM'),'reciente')), 'remito_conforme', r.np);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_remito_entregado falló: %', sqlerrm;
  return -1;
end $function$;

comment on function public.wa_avisos_remito_entregado() is
  'SENTINELA sql/161 (Claude, sesion session_01H69G85yP81jJRETaiZ9Kr5, 2026-10-16, pedido Pablo Olejavetzky). '
  'Avisa entrega/retiro de remitos NO-WEB (es_web=false) desde virgilio.gv_remitos_controlados_bot, por cod_cliente. '
  'Web va por order_tracking (sql/160). Gateado por wa_envio_automatico.';

-- Cron cada 10 min (como lk_aviso-retiro-web).
select cron.schedule('lk_aviso-remito-entregado', '*/10 * * * *', 'select public.wa_avisos_remito_entregado();');
