-- ISIS / Gestión (hrxfctzncixxqmpfhskv) — gate de secreto para lk_factura-check (auditoría 02/10/2026, hallazgo 3.1.1).
-- NO aplicar en PaginaLK. ESTADO: pasos 1 a 4 APLICADOS en Gestión el 05/10/2026 con el "sí" de Pablo y verificados con SELECT
-- (1 secreto de 64 caracteres; wa_factura_check_secret() sólo para service_role; trigger y cron 69 con el header). Falta la llave
-- app_settings.wa_factura_check_gate en PaginaLK: primero 'log', después '1' (cada una con su "sí").
--
-- Problema: lk_factura-check (PaginaLK, verify_jwt = false) no tenía ningún gate. Cualquiera con la URL podía disparar envíos al
-- número de redirección, reclamar grupos en wa_grupo_listo y escribir wa_shadow_log / wa_sim_inbox.
--
-- Llamadores que hoy NO mandan ningún header (los 3 hay que actualizar; verificado el 05/10 en la base viva):
--   1. trigger wa_factura_notificar sobre isis_lk.documentos e isis_ch.documentos (pg_net, por cada factura nueva)
--   2. cron wa_barrido_avisos (jobid 69, cada 15 min: los cuits facturados de hoy y ayer)
--   3. lk_notif-sim (edge de PaginaLK; ya manda el header por código, ver supabase/functions/lk_notif-sim)
--
-- Diseño: el secreto nace y vive en el Vault de GESTIÓN (no se copia a ningún otro lado ni se muestra). El trigger y el cron lo
-- leen del Vault en cada corrida (no queda en cron.job.command). La edge lo lee con wa_factura_check_secret() (sólo service_role).
-- La llave app_settings.wa_factura_check_gate (PaginaLK) escalona el cierre: sin fila = apagado · 'log' = sólo registra · '1' = 401.
--
-- ORDEN: (1) deploy del código [hecho: gate apagado, sin efecto] → (2) este archivo → (3) llave en 'log', mirar los logs un día
-- → (4) llave en '1'. Rollback al final.

-- ── 1. Secreto aleatorio en el Vault (64 hex = 244 bits; el valor no sale de la base) ─────────────────────────────────────────
select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'lk_factura_check_secret',
  'Secreto del endpoint lk_factura-check de PaginaLK (header x-lk-secret). Lo leen el trigger wa_factura_notificar y el cron wa_barrido_avisos; la edge, vía wa_factura_check_secret().'
);

-- ── 2. Función que la edge usa para leerlo: SÓLO service_role (anon y authenticated, sin EXECUTE) ───────────────────────────
create or replace function public.wa_factura_check_secret()
returns text language sql stable security definer set search_path = public, vault, pg_temp as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'lk_factura_check_secret' limit 1
$$;
revoke all on function public.wa_factura_check_secret() from public, anon, authenticated;
grant execute on function public.wa_factura_check_secret() to service_role;

-- ── 3. Trigger: la versión VIGENTE de wa_factura_notificar (isis_wa_dashboard.sql) + el header. Nada más cambia. ──────────────
create or replace function public.wa_factura_notificar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_source text; r record;
begin
  v_source := case tg_table_schema when 'isis_lk' then 'lk' when 'isis_ch' then 'ch' else tg_table_schema end;
  begin
    insert into public.wa_pipeline_log(event, comprobante, cuit, fecha, source)
    select 'factura_generada', comprobante_id, contraparte_cuit, fecha, v_source
    from new_rows where familia = 'factura_venta';
  exception when others then null; end;
  for r in select distinct contraparte_cuit as cuit, fecha from new_rows
           where familia = 'factura_venta' and contraparte_cuit is not null loop
    begin
      perform net.http_post(
        url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
        headers := jsonb_build_object('Content-Type','application/json',
          'x-lk-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'lk_factura_check_secret'), '')),
        body := jsonb_build_object('source', v_source, 'cuit', r.cuit, 'fecha', r.fecha));
    exception when others then null; end;
  end loop;
  return null;
end $$;

-- ── 4. Cron wa_barrido_avisos (jobid 69): mismo comando + el header ─────────────────────────────────────────────────────────
select cron.alter_job(69, command := $cmd$
  select net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-lk-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'lk_factura_check_secret'), '')),
    body := jsonb_build_object('source',c.source,'cuit',c.cuit,'fecha',to_char(dd.d,'YYYY-MM-DD')))
  from (select current_date as d union all select current_date - 1) dd
  cross join lateral public.wa_cuits_facturados_dia(dd.d) c;
$cmd$);

-- ── Verificación (sólo lecturas) ────────────────────────────────────────────────────────────────────────────────────────────
--   select count(*) from vault.secrets where name = 'lk_factura_check_secret';                       -- 1
--   select has_function_privilege('anon', 'public.wa_factura_check_secret()', 'execute');            -- false
--   select command from cron.job where jobid = 69;                                                   -- trae x-lk-secret
--   select prosrc like '%x-lk-secret%' from pg_proc where proname = 'wa_factura_notificar';          -- true

-- ── ROLLBACK (deja todo como estaba el 05/10) ──────────────────────────────────────────────────────────────────────────────
--   -- trigger: volver a la versión de isis_wa_dashboard.sql (headers sólo Content-Type)
--   -- cron:
--   select cron.alter_job(69, command := $cmd$
--     select net.http_post(
--       url:='https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
--       headers:='{"Content-Type":"application/json"}'::jsonb,
--       body:=jsonb_build_object('source',c.source,'cuit',c.cuit,'fecha',to_char(dd.d,'YYYY-MM-DD')))
--     from (select current_date as d union all select current_date - 1) dd cross join lateral public.wa_cuits_facturados_dia(dd.d) c;
--   $cmd$);
--   drop function if exists public.wa_factura_check_secret();
--   delete from vault.secrets where name = 'lk_factura_check_secret';
--   -- y, si ya estaba prendida, apagar la llave en PaginaLK: delete from app_settings where key = 'wa_factura_check_gate';
