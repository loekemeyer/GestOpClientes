-- 145 — (APLICADA 13/10) sincronizar_ppp: GV_Clientes_Whatsapp manda por cliente en wa_clientes_telefono
-- Pedido de Pablo Olejavetzky (13/10, «Aplicalo»). Auditoría: problema 695. Mediciones y propuesta: docs/PROPUESTA-TELEFONOS-695-2026-10-13.md.
--
-- Regla: los teléfonos de clientes de Loekemeyer salen de virgilio.gv_clientes_whatsapp (con empresa). La vieja (virgilio.whatsapp_clientes,
-- sin empresa) sólo completa a los clientes que GV no tiene, y sigue sin traer los teléfonos que son sólo de Chef (sql/086, auditoría 616).
-- Efecto medido el 13/10 sobre las fuentes de ese día: wa_clientes_telefono pasa de 792 a 807 filas (15 clientes que sólo estaban en GV) y
-- ningún cliente pierde su teléfono (las 14 diferencias entre fuentes son el mismo número con otro formato).
--
-- Efecto que la propuesta no previó (medido tras aplicar): 6 de esos 15 teléfonos nuevos coinciden con el de OTRO cliente de Loekemeyer con distinto CUIT.
-- Para wa_identify_customer (sql/073) un teléfono de dos empresas distintas no identifica a nadie, así que esos 6 clientes «otros» (y sus 6 pares nuevos)
-- pasan a vinculación con revisión humana. Ninguno es del piloto. Se dejó así a propósito: es el comportamiento seguro y deja a la vista un dato a limpiar.
--
-- Sólo se cambia el INSERT del bloque de teléfonos de sincronizar_ppp(). El resto de la función se conserva tal cual: el cambio se hace sobre la
-- definición que tiene la base (no sobre una copia pegada) y no hace nada si no encuentra el bloque o si ya está aplicado.
-- Rollback: zz_backups.bkp_sincronizar_ppp_20261013 (definición anterior).

create table if not exists zz_backups.bkp_sincronizar_ppp_20261013 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sincronizar_ppp';
alter table zz_backups.bkp_sincronizar_ppp_20261013 enable row level security;

do $mig$
declare
  d text;
  ini int;
  fin int;
  nuevo text := $n$INSERT INTO public.wa_clientes_telefono (cod_cliente, telefono, actualizado)
    -- Auditoría 695: GV_Clientes_Whatsapp (con empresa) manda por cliente. La vieja sólo completa a los clientes que GV no tiene,
    -- sin los teléfonos que son sólo de Chef (sql/086, auditoría 616).
    WITH g AS MATERIALIZED (
      SELECT empresa, cod_cliente, telefono, actualizado,
             right(regexp_replace(telefono, '\D', '', 'g'), 10) AS t
      FROM virgilio.gv_clientes_whatsapp
      WHERE telefono IS NOT NULL AND btrim(telefono) <> '')
    SELECT g.cod_cliente, g.telefono, g.actualizado FROM g WHERE g.empresa = 'LK'
    UNION ALL
    SELECT w.cod_cliente::text, w.telefono, w.actualizado
    FROM virgilio.whatsapp_clientes w
    WHERE w.telefono IS NOT NULL AND btrim(w.telefono) <> ''
      AND NOT EXISTS (SELECT 1 FROM g WHERE g.empresa = 'LK' AND g.cod_cliente = w.cod_cliente::text)
      AND NOT (EXISTS (SELECT 1 FROM g WHERE g.empresa = 'CH' AND g.cod_cliente = w.cod_cliente::text
                         AND g.t = right(regexp_replace(w.telefono, '\D', '', 'g'), 10))
               AND NOT EXISTS (SELECT 1 FROM g WHERE g.empresa = 'LK' AND g.cod_cliente = w.cod_cliente::text
                         AND g.t = right(regexp_replace(w.telefono, '\D', '', 'g'), 10)));
    $n$;
begin
  select pg_get_functiondef('public.sincronizar_ppp()'::regprocedure) into d;
  if position('Auditoría 695' in d) > 0 then
    raise notice 'sql/145 ya estaba aplicada, no se cambia nada';
    return;
  end if;
  ini := position('INSERT INTO public.wa_clientes_telefono' in d);
  fin := position('GET DIAGNOSTICS n_tel = ROW_COUNT;' in d);
  if ini = 0 or fin = 0 or fin < ini or substr(d, ini, fin - ini) not like '%virgilio.whatsapp_clientes%' then
    raise exception 'sql/145: no encontré el bloque de teléfonos de sincronizar_ppp, no se cambia nada';
  end if;
  d := left(d, ini - 1) || nuevo || substr(d, fin);
  execute d;
end
$mig$;
