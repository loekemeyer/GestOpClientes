-- 149 · memoria del último año a demanda (Pablo Olejavetzky, 14/10/2026, P3 del plan de los 8 puntos)
--
-- Le da al agente "memoria del último año" sin meterla en el prompt de cada turno: una herramienta que busca en el
-- historial del PROPIO cliente cuando éste trae algo viejo que no está en la ventana ("lo que te consulté hace meses").
-- Dos fuentes, sólo de quien escribe:
--   · Wpp_Historial_Clientes (año importado 2025-06 a 2026-06), unido por Wpp_Conversaciones_Clientes a (cod_cli, marca).
--   · bot_historial_chat (lo vivo del bot), por teléfono.
-- Sin embeddings a propósito (REQUERIMIENTOS-AGENTE-2026-10-09.md): el volumen por cliente es chico y el ILIKE, ya
-- acotado al cliente, resuelve en ms.
--
-- ⚠ AISLAMIENTO: cod_cliente y marca son INDEPENDIENTES entre LK y CH (el mismo código es otro cliente en cada empresa),
-- así que la búsqueda en el año filtra por (cod_cli, marca) usando la EMPRESA del teléfono (bot_customer_whatsapps.empresa).
-- Sin ese filtro se mezclarían dos clientes distintos. La parte viva va por teléfono, que ya es de un solo cliente.
--
-- SECURITY DEFINER con EXECUTE revocado a anon/authenticated (la llama el bot con service_role). Idempotente.
-- Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg).

create or replace function public.bot_buscar_mi_historial(p_telefono text, p_query text, p_limite int default 6)
returns table(fecha date, quien text, fuente text, texto text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_cod   bigint;
  v_marca text;
  v_dig   text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_q     text := btrim(coalesce(p_query, ''));
begin
  -- query muy corta o sin teléfono: no devuelve nada (no vuelca el historial entero)
  if length(v_q) < 3 or v_dig = '' then
    return;
  end if;

  -- cliente y empresa del teléfono (vínculo agendado manda; la empresa define LK vs CH)
  select cw.cod_cliente, upper(coalesce(cw.empresa, 'LK'))
    into v_cod, v_marca
  from public.bot_customer_whatsapps cw
  where regexp_replace(coalesce(cw.whatsapp, ''), '[^0-9]', '', 'g') = v_dig
  order by cw.is_primary desc, cw.created_at desc
  limit 1;

  -- sin vínculo agendado: el mismo reconocimiento del ERP que usa el webhook (siempre LK)
  if v_cod is null then
    select c.cod_cliente, 'LK'
      into v_cod, v_marca
    from public.wa_identify_customer(p_telefono) w
    join public.customers c on c.id = w.customer_id
    limit 1;
  end if;

  if v_cod is null then
    return;
  end if;

  return query
  with hist as (
    select h.creado_en, h.rol, coalesce(nullif(h.fuente, ''), 'historial') as fuente, h.contenido
    from public."Wpp_Historial_Clientes" h
    join public."Wpp_Conversaciones_Clientes" cc on cc.conversacion_id = h.conversacion_id
    where cc.cod_cli = v_cod
      and upper(coalesce(cc.marca, 'LK')) = v_marca
      and h.contenido ilike '%' || v_q || '%'
    union all
    select b.creado_en, b.rol, 'bot' as fuente, b.contenido
    from public.bot_historial_chat b
    where regexp_replace(coalesce(b.telefono, ''), '[^0-9]', '', 'g') = v_dig
      and b.contenido ilike '%' || v_q || '%'
  )
  select (creado_en)::date as fecha,
         case when rol = 'user' then 'cliente' else 'empresa' end as quien,
         fuente,
         left(regexp_replace(contenido, '\s+', ' ', 'g'), 240) as texto
  from hist
  order by creado_en desc
  limit greatest(1, least(coalesce(p_limite, 6), 12));
end
$function$;

revoke all on function public.bot_buscar_mi_historial(text, text, int) from anon, authenticated;
