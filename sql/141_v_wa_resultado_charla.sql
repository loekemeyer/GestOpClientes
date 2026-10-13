-- 141 · v_wa_resultado_charla — medida del Objetivo (P1 del plan de los 8 puntos, Pablo Olejavetzky 13/10/2026)
--
-- Clasifica cada CHARLA CERRADA en uno de cinco resultados, para poder medir si el agente cumple su objetivo
-- ("la consulta queda resuelta sin pasar a una persona; y si es un pedido, queda en precarga tal como el
-- vendedor la aprueba"). Una charla = filas de bot_historial_chat del mismo teléfono partidas por gaps > 12 h
-- (mismo corte que la memoria). Cerrada = su última fila es de hace más de 12 h y tuvo al menos 1 mensaje del
-- cliente. Precedencia de la clasificación: precarga confirmada › derivada › sin_respuesta › resuelta.
--
-- Estados:
--   resuelta                       contestó la IA o la capa fija y no hubo derivación ni pase a persona.
--   derivada                       hubo una alerta a una persona (escalation o alta de cliente) en la ventana.
--   precarga_aprobada_sin_cambios  un pedido por WhatsApp quedó precargado y el vendedor lo confirmó sin nota.
--   precarga_con_cambios           el vendedor confirmó la precarga dejando una nota (intervención).
--   sin_respuesta                  el cliente escribió y el bot no produjo ninguna respuesta (del_bot = 0).
--
-- Los dos estados de precarga quedan en 0 hasta que entre y se apruebe el primer pedido por WhatsApp
-- (wa_pedido_precarga hoy está vacía). No es un bug: son latentes por falta de datos, no por la vista.
--
-- Seguridad: revocada de anon y authenticated (expone el teléfono y metadatos de la charla). Se lee desde
-- Conversaciones con rol admin / service_role.
--
-- Idempotente. Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicada el 13/10/2026.

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
    exists (
      select 1 from public.wa_alertas_humano a
       where a.phone = c.telefono
         and a.tipo in ('escalation','alta_cliente_nuevo')
         and a.created_at between c.inicio - interval '2 minutes' and c.fin + interval '5 minutes'
    ) as hubo_derivacion,
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
    when hubo_derivacion then 'derivada'
    when del_bot = 0 then 'sin_respuesta'
    else 'resuelta'
  end as estado
from clasif
order by fin desc;

revoke all on public.v_wa_resultado_charla from anon, authenticated;
