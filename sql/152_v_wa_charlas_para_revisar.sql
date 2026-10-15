-- 152 · v_wa_charlas_para_revisar — el worklist de la revisión diaria del piloto (P8.3, Pablo Olejavetzky 14/10/2026)
--
-- Lista las charlas cerradas que quedaron 'derivada' o 'sin_respuesta' (de v_wa_resultado_charla, sql/141), con el
-- cliente, el motivo de la derivación y el último mensaje del cliente. Es la lista de QUÉ mirar en la revisión diaria
-- (30-45 min ya previstos): a cada una se le da su salida con los flujos que ya existen — corrección en el artifact
-- "Respuestas del bot por causa" (A/B), cambio de capa fija (C, código), tarea de Planify (D) o "correcta, así tenía
-- que derivar". No duplica un registro de salidas: usa esos canales.
--
-- Clave natural de cada charla: (telefono, fin). Seguridad: revocada de anon/authenticated (expone teléfono y texto),
-- se lee con rol admin desde el dashboard. Idempotente. Se corre a mano en el SQL editor de PaginaLK.

create or replace view public.v_wa_charlas_para_revisar as
select r.telefono, r.charla_id, r.inicio, r.fin, r.estado, r.del_cliente, r.del_bot,
  cli.cod_cliente, cli.business_name,
  (select a.tipo || coalesce(' · ' || nullif(left(a.contexto::text, 80), ''), '')
     from public.wa_alertas_humano a
    where a.phone = r.telefono
      and a.created_at between r.inicio - interval '2 minutes' and r.fin + interval '5 minutes'
    order by a.created_at desc limit 1) as motivo,
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
