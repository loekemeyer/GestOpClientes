-- 127 — sync_web_ocultos_virgilio(): 4 guardas + un solo refresco de item_precio_cache por corrida (Pablo, 06/10).
-- APLICADA el 06/10/2026 a las 11:37:59 AR en PaginaLK (kwkclwhmoygunqmlegrg) con la migración
-- `sync_web_ocultos_virgilio_guardas_y_un_refresco`, con el ok de Luis. NO hace falta volver a aplicarla.
-- Problema de auditoría: "sync_reingresos_virgilio tarda ~11 s por corrida: 4 reconstrucciones completas de
-- item_precio_cache sin cambios" (corregido). Resultado medido: cron 39 de ~11,1 s a ~7,1 s; 1 reconstrucción por corrida.
-- ⚠ Esta función NO nació en este repo (el comentario del cuerpo la atribuye a Luis, 24/09, Gestión v22.23/25): si el repo
-- que la despliega vuelve a correr su versión anterior, este cambio se pierde sin aviso. Vuelta atrás: sql/rollback/127_*.sql.
-- md5 del cuerpo (prosrc): 40fc94dd551f55afc4a90116fe5d698a. Detalle: docs/ESTADO.md (entrada del 06/10).
-- ⚠ NO SACAR el `perform public.refrescar_item_precio_cache();` final: el latido lk-item-precio-heartbeat (job 79) y la RPC
-- web_ocultos_poke (Thomas, 06/10, Gestion-Virgilio/sql/gv_*_20261006_LK.sql) llaman a esta función justo para disparar ese refresco
-- (precios de Chef, sin trigger local); sin él no hacen nada. Desde el 06/10 el cron 39 corre cada 15 min con huella, no cada 5.
-- Dónde vive el código original: no hay SQL ejecutable en los repos revisados (ver docs/ESTADO.md). Los ~11,1 s -> ~7,1 s son de la corrida de las 11:43 AR del 06/10.
CREATE OR REPLACE FUNCTION public.sync_web_ocultos_virgilio()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Luis 24/09 (Gestion v22.23/25): switch "Web" de Importados, por empresa. La lista vive en
-- Virgilio (GV_Web_Oculto). Ocultar = active=false (LK: products y loke_products; CH: products
-- de Chef por el FDW chef_db). Solo reactiva lo que oculto ESTE switch (web_oculto_gestion).
-- Si Virgilio no contesta, no toca nada. Chef va en bloque propio: si falla (p.ej. falta el
-- grant update(active) a loke_reader en Chef) lo de LK ya quedo aplicado.
-- 06/10 (Pablo): cada UPDATE de LK corre SOLO si hay filas para cambiar. Un UPDATE sin filas igual dispara los
-- triggers por sentencia de products/loke_products (refrescar_item_precio_cache: borra y reinserta item_precio_cache
-- + ANALYZE, ~2 s): eran 4 por corrida, cada 5 min. Esas reconstrucciones eran lo único que mantenía fresca la
-- cache para los productos de Chef (leidos por FDW, sin trigger local), asi que se hace UNA explicita al final.
declare v_lk text[]; v_ch text[];
begin
  select coalesce(array_agg(distinct upper(regexp_replace(btrim(cod),'^0+(?=\d)',''))) filter (where empresa='LK'), '{}'),
         coalesce(array_agg(distinct upper(regexp_replace(btrim(cod),'^0+(?=\d)',''))) filter (where empresa='CH'), '{}')
    into v_lk, v_ch
    from virgilio.v_lk_web_ocultos where nullif(btrim(cod),'') is not null;

  -- LK: products
  if exists (select 1 from public.products p
              where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk)) then
    with oc as (update public.products p set active = false
                 where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk) returning p.cod)
    insert into public.web_oculto_gestion (cod, tabla) select cod, 'products' from oc on conflict do nothing;
  end if;
  if exists (select 1 from public.web_oculto_gestion w
              where w.tabla = 'products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk)) then
    with dev as (delete from public.web_oculto_gestion w
                  where w.tabla = 'products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk) returning w.cod)
    update public.products p set active = true from dev where p.cod = dev.cod and not p.active;
  end if;

  -- LK: linea Loke
  if exists (select 1 from public.loke_products p
              where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk)) then
    with oc as (update public.loke_products p set active = false
                 where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk) returning p.cod)
    insert into public.web_oculto_gestion (cod, tabla) select cod, 'loke_products' from oc on conflict do nothing;
  end if;
  if exists (select 1 from public.web_oculto_gestion w
              where w.tabla = 'loke_products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk)) then
    with dev as (delete from public.web_oculto_gestion w
                  where w.tabla = 'loke_products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk) returning w.cod)
    update public.loke_products p set active = true from dev where p.cod = dev.cod and not p.active;
  end if;

  -- CH: products de Chef (FDW). Sin cambios pendientes no toca el FDW.
  begin
    if cardinality(v_ch) > 0 then
      with oc as (update chef_ext.products p set active = false
                   where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_ch) returning p.cod)
      insert into public.web_oculto_gestion (cod, tabla) select cod, 'chef' from oc on conflict do nothing;
    end if;
    if exists (select 1 from public.web_oculto_gestion w where w.tabla = 'chef'
                and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_ch)) then
      with dev as (delete from public.web_oculto_gestion w
                    where w.tabla = 'chef' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_ch) returning w.cod)
      update chef_ext.products p set active = true from dev where p.cod = dev.cod and not p.active;
    end if;
  exception when others then
    raise notice 'sync_web_ocultos_virgilio (chef): %', sqlerrm;
  end;

  -- Una sola reconstruccion de la cache de precios por corrida (antes 4, una por cada UPDATE sin filas). Mantiene
  -- al dia los productos de Chef (fuente 'chef_products') que ningun trigger local detecta.
  perform public.refrescar_item_precio_cache();
exception when others then
  raise notice 'sync_web_ocultos_virgilio: %', sqlerrm;
end $function$;
