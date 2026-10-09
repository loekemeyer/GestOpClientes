-- 138 — Clientes a los que les falta la ficha de memoria (Pablo Olejavetzky, 09/10/2026: "sí, armalo", las fichas de todos).
-- La usa lk_memoria-cliente {action:"armar_pendientes"} para recorrerlos de a tandas. Un cliente entra si tiene al menos una
-- charla propia con mensajes (las compartidas con otro cliente no se leen, sql/137) y todavía no tiene fila en wa_memoria_cliente.
-- Medido el 09/10: 504 de los 664 clientes tienen charla propia; los otros 160 sólo aparecen en charlas compartidas.

create or replace function public.wa_memoria_pendientes(p_limite integer default 10)
returns table (marca text, cod_cli integer)
language sql stable security definer set search_path = public as $$
  with propias as (
    select conversacion_id from "Wpp_Conversaciones_Clientes" group by conversacion_id having count(*) = 1
  )
  select distinct cc.marca, cc.cod_cli
    from "Wpp_Conversaciones_Clientes" cc
    join propias p on p.conversacion_id = cc.conversacion_id
   where exists (select 1 from "Wpp_Historial_Clientes" h where h.conversacion_id = cc.conversacion_id)
     and not exists (select 1 from public.wa_memoria_cliente m where m.marca = cc.marca and m.cod_cli = cc.cod_cli)
   order by cc.marca, cc.cod_cli
   limit greatest(1, least(p_limite, 50));
$$;
revoke all on function public.wa_memoria_pendientes(integer) from public, anon, authenticated;
grant execute on function public.wa_memoria_pendientes(integer) to service_role;

-- Rollback:
--   drop function if exists public.wa_memoria_pendientes(integer);
