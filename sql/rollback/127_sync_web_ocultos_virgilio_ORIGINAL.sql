-- ⚠ VUELTA ATRÁS — NO APLICAR salvo que haya que deshacer sql/127 (por eso vive en sql/rollback/ y no entre las migraciones).
-- Definición ORIGINAL de public.sync_web_ocultos_virgilio() en PaginaLK, leída el 06/10/2026 antes del cambio.
-- Aplicarla vuelve a las 4 reconstrucciones inútiles de item_precio_cache por corrida (cron 39 de ~7,1 s a ~11,1 s).
-- md5 del cuerpo (prosrc): 8047413d9c5e4cbac98812f6c1326230 (3.081 caracteres): lo que había en la base antes del cambio.
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
declare v_lk text[]; v_ch text[];
begin
  select coalesce(array_agg(distinct upper(regexp_replace(btrim(cod),'^0+(?=\d)',''))) filter (where empresa='LK'), '{}'),
         coalesce(array_agg(distinct upper(regexp_replace(btrim(cod),'^0+(?=\d)',''))) filter (where empresa='CH'), '{}')
    into v_lk, v_ch
    from virgilio.v_lk_web_ocultos where nullif(btrim(cod),'') is not null;

  -- LK: products
  with oc as (update public.products p set active = false
               where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk) returning p.cod)
  insert into public.web_oculto_gestion (cod, tabla) select cod, 'products' from oc on conflict do nothing;
  with dev as (delete from public.web_oculto_gestion w
                where w.tabla = 'products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk) returning w.cod)
  update public.products p set active = true from dev where p.cod = dev.cod and not p.active;

  -- LK: linea Loke
  with oc as (update public.loke_products p set active = false
               where p.active and upper(regexp_replace(btrim(p.cod),'^0+(?=\d)','')) = any(v_lk) returning p.cod)
  insert into public.web_oculto_gestion (cod, tabla) select cod, 'loke_products' from oc on conflict do nothing;
  with dev as (delete from public.web_oculto_gestion w
                where w.tabla = 'loke_products' and upper(regexp_replace(btrim(w.cod),'^0+(?=\d)','')) <> all(v_lk) returning w.cod)
  update public.loke_products p set active = true from dev where p.cod = dev.cod and not p.active;

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
exception when others then
  raise notice 'sync_web_ocultos_virgilio: %', sqlerrm;
end $function$;
