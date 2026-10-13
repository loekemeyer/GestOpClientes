-- 146 · v_wa_resultado_semana — medida semanal del piloto (P8 del plan de los 8 puntos, Pablo Olejavetzky 13/10/2026)
-- (numerado 146: otra sesión tomó sql/145 el mismo día — regla multi-sesión, la segunda renumera)
--
-- Agrega por semana (lunes, hora de Argentina) lo que clasifica v_wa_resultado_charla (sql/141), más la latencia
-- (v_wa_turno_tiempos) y el gasto de IA del webhook (bot_token_usage). Es la foto que mira el piloto: cuántas
-- charlas, cuántas resueltas sin persona, cuántas derivadas, p50/p90 de respuesta y cuánto costó.
--
-- Columnas: semana, charlas, resueltas, derivadas, precarga_ok, precarga_cambios, sin_respuesta,
-- pct_resueltas, pct_derivadas, turnos, turnos_ia, p50_s, p90_s, gasto_usd.
-- turnos/p50/p90 quedan en null en las semanas sin filas en wa_turno_tiempos (esa tabla arrancó después); se
-- llenan con el tráfico del piloto. gasto_usd es sólo del webhook real (el Simulador no cuenta).
--
-- Seguridad: revocada de anon/authenticated (se lee desde el reporte y Conversaciones con service_role / admin).
-- Idempotente. Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicada el 13/10/2026.

create or replace view public.v_wa_resultado_semana as
with charlas as (
  select date_trunc('week', (fin at time zone 'America/Argentina/Buenos_Aires'))::date as semana,
    count(*) as charlas,
    count(*) filter (where estado='resuelta') as resueltas,
    count(*) filter (where estado='derivada') as derivadas,
    count(*) filter (where estado='precarga_aprobada_sin_cambios') as precarga_ok,
    count(*) filter (where estado='precarga_con_cambios') as precarga_cambios,
    count(*) filter (where estado='sin_respuesta') as sin_respuesta
  from public.v_wa_resultado_charla group by 1
),
tiempos as (
  select date_trunc('week', (recibido_at at time zone 'America/Argentina/Buenos_Aires'))::date as semana,
    count(*) as turnos,
    count(*) filter (where ia) as turnos_ia,
    round((percentile_cont(0.5) within group (order by respuesta_s))::numeric, 2) as p50_s,
    round((percentile_cont(0.9) within group (order by respuesta_s))::numeric, 2) as p90_s
  from public.v_wa_turno_tiempos where envios > 0 and not concurrente group by 1
),
gasto as (
  select date_trunc('week', (created_at at time zone 'America/Argentina/Buenos_Aires'))::date as semana,
    round(sum(estimated_cost_usd)::numeric, 4) as gasto_usd
  from public.bot_token_usage where function_name = 'lk_whatsapp-webhook' group by 1
)
select coalesce(c.semana, t.semana, g.semana) as semana,
  coalesce(c.charlas, 0) as charlas,
  coalesce(c.resueltas, 0) as resueltas,
  coalesce(c.derivadas, 0) as derivadas,
  coalesce(c.precarga_ok, 0) as precarga_ok,
  coalesce(c.precarga_cambios, 0) as precarga_cambios,
  coalesce(c.sin_respuesta, 0) as sin_respuesta,
  case when coalesce(c.charlas,0) > 0 then round(100.0 * c.resueltas / c.charlas, 1) end as pct_resueltas,
  case when coalesce(c.charlas,0) > 0 then round(100.0 * c.derivadas / c.charlas, 1) end as pct_derivadas,
  t.turnos, t.turnos_ia, t.p50_s, t.p90_s,
  coalesce(g.gasto_usd, 0) as gasto_usd
from charlas c
  full join tiempos t on t.semana = c.semana
  full join gasto g on g.semana = coalesce(c.semana, t.semana)
order by semana desc;

revoke all on public.v_wa_resultado_semana from anon, authenticated;
