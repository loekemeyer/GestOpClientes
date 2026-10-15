-- 158 · v_wa_resultado_charla cuenta como 'derivada' todo pase a una persona, no sólo escalation (P8 del plan de los 8 puntos,
-- Pablo Olejavetzky 15/10/2026: «Sí, arrancá con P8»)
--
-- Qué estaba mal (sql/141): 'derivada' sólo miraba alertas de tipo escalation o alta_cliente_nuevo. Los otros caminos que pasan
-- la charla a una persona quedaban afuera:
--   · bot_pausa (tipo 'otro'): la charla del 13/10 de Bazar Farimar (bot pausado, «Buenas, cuando sale mi pedido», tarea 5674)
--     salía 'sin_respuesta', como si el bot hubiera fallado, cuando lo correcto era que la tomara una persona.
--   · reclamo, entrega, reseteo_clave, tope_ia (tipo 'otro'), adjunto_recibido / pedido_archivo, comprobante_recibido, reclamo
--     por foto, IA caída (llm_timeout / llm_error, sql/141 la contaba 'resuelta' o 'sin_respuesta' según hubiera texto).
-- Y la ventana tomaba cualquier alerta, incluidas las que no son un pase a persona (whitelist_gate, faq_no_match, envio_fallido).
--
-- Criterio: la misma lista cerrada de motivos que la memoria de la charla (supabase/functions/_shared/hechos-charla.ts, MOTIVOS),
-- más bot_pausa, tope_ia y tope_gasto (en esos tres una persona mira el chat, Configuración › Derivaciones) y la IA caída. Con motivo,
-- vale el motivo. Sin motivo, vale el tipo. Las alertas del simulador no cuentan. Un motivo nuevo que nadie agregó acá NO cuenta
-- como derivación: falla cerrado, igual que hechos-charla.ts. Si se agrega un motivo de derivación nuevo, sumarlo en los dos lados.
--
-- Agrega al final de la vista la columna motivos_derivacion (los motivos de esa charla, separados por coma) para el reporte del
-- piloto. v_wa_charlas_para_revisar (sql/152) muestra primero la alerta de derivación y nunca un whitelist_gate.
--
-- Idempotente. Rollback: sql/rollback/158_wa_resultado_charla_derivaciones.sql (vuelve a sql/141 y sql/152).

create or replace function public.wa_alerta_es_derivacion(p_tipo text, p_contexto jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when coalesce(p_contexto->>'simulador', '') = 'true' then false
    when nullif(p_contexto->>'motivo', '') is not null then p_contexto->>'motivo' = any (array[
      'entrega','reclamo','pago','reclamo_saldo','cambio_pedido','anulacion_pedido','pedido_no_encontrado','excepcion_minimo',
      'cambio_datos','consulta_stock','devolucion','acceso_web','reseteo_clave','nota_cliente','pedido_archivo','pedido_mail',
      'pedido_whatsapp','respuesta_aviso_cambio','cliente_molesto','cliente_chef','alta_cliente','alta_cliente_nuevo',
      'solicitud_alta_completa','adjunto_recibido','comprobante_recibido','comprobante_error','escalation',
      'bot_pausa','tope_ia','tope_gasto'])
    else coalesce(p_tipo, '') = any (array[
      'escalation','alta_cliente_nuevo','comprobante_recibido','comprobante_error','reclamo','adjunto_recibido','llm_timeout','llm_error'])
  end
$$;

revoke all on function public.wa_alerta_es_derivacion(text, jsonb) from anon, authenticated;

create or replace view public.v_wa_resultado_charla as
with base as (
  select telefono, creado_en, rol,
    case when lag(creado_en) over (partition by telefono order by creado_en) is null
           or creado_en - lag(creado_en) over (partition by telefono order by creado_en) > interval '12 hours'
         then 1 else 0 end as nueva
  from public.bot_historial_chat
),
marc as (
  select telefono, creado_en, rol,
    sum(nueva) over (partition by telefono order by creado_en rows unbounded preceding) as charla_id
  from base
),
charlas as (
  select telefono, charla_id,
    min(creado_en) as inicio, max(creado_en) as fin,
    count(*) as msgs,
    count(*) filter (where rol = 'user') as del_cliente,
    count(*) filter (where rol = 'assistant') as del_bot
  from marc
  group by telefono, charla_id
),
cerradas as (
  select * from charlas
  where del_cliente > 0 and fin < now() - interval '12 hours'
),
clasif as (
  select c.*,
    (select string_agg(distinct coalesce(nullif(a.contexto->>'motivo', ''), a.tipo), ', ')
       from public.wa_alertas_humano a
      where a.phone = c.telefono
        and a.created_at between c.inicio - interval '2 minutes' and c.fin + interval '5 minutes'
        and public.wa_alerta_es_derivacion(a.tipo, a.contexto)) as motivos_derivacion,
    (select p.estado from public.wa_pedido_precarga p
       where p.phone = c.telefono
         and p.created_at between c.inicio - interval '2 minutes' and c.fin + interval '5 minutes'
       order by p.created_at desc limit 1) as precarga_estado,
    (select p.nota from public.wa_pedido_precarga p
       where p.phone = c.telefono
         and p.created_at between c.inicio - interval '2 minutes' and c.fin + interval '5 minutes'
       order by p.created_at desc limit 1) as precarga_nota
  from cerradas c
)
select telefono, charla_id, inicio, fin, msgs, del_cliente, del_bot,
  case
    when precarga_estado in ('confirmado','cargado') and precarga_nota is null then 'precarga_aprobada_sin_cambios'
    when precarga_estado in ('confirmado','cargado') then 'precarga_con_cambios'
    when motivos_derivacion is not null then 'derivada'
    when del_bot = 0 then 'sin_respuesta'
    else 'resuelta'
  end as estado,
  motivos_derivacion
from clasif
order by fin desc;

revoke all on public.v_wa_resultado_charla from anon, authenticated;

create or replace view public.v_wa_charlas_para_revisar as
select r.telefono, r.charla_id, r.inicio, r.fin, r.estado, r.del_cliente, r.del_bot,
  cli.cod_cliente, cli.business_name,
  (select a.tipo || coalesce(' · ' || nullif(left(a.contexto::text, 80), ''), '')
     from public.wa_alertas_humano a
    where a.phone = r.telefono
      and a.tipo <> 'whitelist_gate'
      and a.created_at between r.inicio - interval '2 minutes' and r.fin + interval '5 minutes'
    order by public.wa_alerta_es_derivacion(a.tipo, a.contexto) desc, a.created_at desc limit 1) as motivo,
  (select left(b.contenido, 160) from public.bot_historial_chat b
     where b.telefono = r.telefono and b.rol = 'user'
       and b.creado_en between r.inicio and r.fin
     order by b.creado_en desc limit 1) as ultimo_cliente
from public.v_wa_resultado_charla r
left join lateral (
  select c.cod_cliente, c.business_name
  from public.bot_customer_whatsapps cw
  join public.customers c on c.id = cw.customer_id
  where regexp_replace(coalesce(cw.whatsapp, ''), '[^0-9]', '', 'g') = regexp_replace(r.telefono, '[^0-9]', '', 'g')
  order by cw.is_primary desc nulls last
  limit 1
) cli on true
where r.estado in ('derivada', 'sin_respuesta')
order by r.fin desc;

revoke all on public.v_wa_charlas_para_revisar from anon, authenticated;
