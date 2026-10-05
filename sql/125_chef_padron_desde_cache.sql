-- 125 — El padrón de Chef sale de la misma copia que ya se hace cada 10 minutos
-- Pedido de Pablo Olejavetzky (05/10). Mapa de copias entre bases: https://claude.ai/artifact/AdXACio7NmBNa439QegciX
--
-- Antes: los clientes de Chef se leían DOS veces de la base de Chef (por FDW) y se guardaban en dos tablas:
--   · chef_padron        ← refrescar_chef_padron(), 1 vez por día (cron 12 sincronizar-chef-diario, 00:20 AR)
--   · chef_customers_cache + chef_dirs_cache ← sincronizar_chef_orders(), cada 10 min (cron 48)
-- Medido el 05/10: las dos tenían los mismos 766 clientes y ningún CUIT distinto, pero el padrón podía quedar
-- hasta 24 h atrasado (un cliente nuevo de Chef no lo reconocía bot_identificar_chef hasta el día siguiente).
--
-- Ahora: refrescar_chef_padron() arma el padrón con las copias locales (chef_customers_cache + chef_dirs_cache),
-- con la misma regla de dirección de siempre, y sincronizar_chef_orders() la llama al final de cada corrida.
-- Una sola lectura de Chef, y las dos tablas salen de la misma foto en la misma transacción.
--
-- Por qué NO se convirtió chef_padron en vista: dependen 14 vistas en 5 niveles (v_pedidos_web, v_pedidos_web_np,
-- bot_cuentas, gv_ventas_*…) y 20 funciones. Pasarla a vista obliga a borrarla con CASCADE y recrear las 14. La tabla
-- queda igual (columnas, clave, permisos, política de lectura): nadie que la lea se entera del cambio.
--
-- Cambios de comportamiento:
--   · El padrón se actualiza cada 10 min en vez de 1 vez por día.
--   · Sólo se reescriben las filas que cambiaron (antes las 766 todos los días). actualizado_at pasa a ser
--     "último cambio" en vez de "última corrida"; ninguna función ni vista lo lee (verificado el 05/10).
--   · Sigue sin borrar: un cliente que desaparece de Chef queda en el padrón, como antes.
--   · Si el padrón falla, la copia de pedidos de Chef NO se deshace: queda anotado en chef_cache_log.motivo.
--   · sincronizar_chef() (cron 12) sigue llamando a refrescar_chef_padron(): ahora lee local, ya no va a Chef.
--
-- Prueba en seco del 05/10 (antes de aplicar): la consulta nueva contra las copias locales da 766 clientes,
-- 0 nuevos y 0 distintos respecto de chef_padron.
-- Rollback: zz_backups.bkp_chef_padron_fn_20261005 tiene las dos definiciones anteriores.

create table if not exists zz_backups.bkp_chef_padron_fn_20261005 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('refrescar_chef_padron', 'sincronizar_chef_orders');
alter table zz_backups.bkp_chef_padron_fn_20261005 enable row level security;

create or replace function public.refrescar_chef_padron()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_n int;
BEGIN
  WITH dir AS (
    -- La direccion REAL del cliente de Chef vive en `label`, igual que en lk
    -- (ver datos_cliente_empresa.lk_dir). direccion_entrega es el DEPOSITO del
    -- expreso (Pergamino 3751 lo comparten clientes de San Juan, Entre Rios y
    -- Corrientes) y agrupaba clientes ajenos. En Chef ademas localidad viene
    -- vacia, asi que la ciudad real SOLO esta en label. Se descartan los labels
    -- de retiro/deposito sin numero de calle. Cambiado el 4/8/2026 (mismo fix que lk).
    -- sql/125: se lee de la copia local chef_dirs_cache, no de la base de Chef.
    SELECT DISTINCT ON (a.customer_id) a.customer_id, btrim(a.label) AS dir
    FROM chef_dirs_cache a
    WHERE btrim(COALESCE(a.label,'')) <> ''
      AND NOT (a.label !~ '[0-9]' AND norm_razon_social(a.label) ~ '(retira|deposito)')
    ORDER BY a.customer_id, a.slot NULLS LAST
  ), src AS (
    SELECT cc.cod_cliente::text AS cod,
           COALESCE(NULLIF(btrim(cc.business_name),''),'') AS nom,
           NULLIF(regexp_replace(COALESCE(cc.cuit,''),'[^0-9]','','g'),'') AS cuit,
           d.dir
    FROM chef_customers_cache cc
    LEFT JOIN dir d ON d.customer_id = cc.id
    WHERE cc.cod_cliente IS NOT NULL
  )
  INSERT INTO chef_padron (cod_cliente, business_name, cuit, direccion, actualizado_at)
  SELECT cod, nom, cuit, dir, now() FROM src
  ON CONFLICT (cod_cliente) DO UPDATE
    SET business_name = EXCLUDED.business_name,
        cuit          = EXCLUDED.cuit,
        direccion     = EXCLUDED.direccion,
        actualizado_at = now()
    -- sql/125: sólo lo que cambió (corre cada 10 min; antes reescribía las 766 filas).
    WHERE (chef_padron.business_name, chef_padron.cuit, chef_padron.direccion)
          IS DISTINCT FROM (EXCLUDED.business_name, EXCLUDED.cuit, EXCLUDED.direccion);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

-- sincronizar_chef_orders: llamar al padrón al final, después de recargar las copias de clientes y direcciones.
-- Se reemplaza sólo ese pedazo (mismo método que sql/086) para no reescribir a mano una función de 5.000 caracteres.
do $$
declare d text; viejo text; nuevo text;
begin
  d := pg_get_functiondef('public.sincronizar_chef_orders(integer)'::regprocedure);
  if position('refrescar_chef_padron' in d) > 0 then
    raise notice 'sincronizar_chef_orders ya llama a refrescar_chef_padron: no se toca';
    return;
  end if;
  viejo := E'  insert into public.chef_cache_log (ok, motivo, n_orders, n_customers, n_dirs, ms)\n  values (true, v_dif,';
  nuevo := $n$  -- sql/125: el padrón de Chef sale de esta misma copia (antes se releía de Chef una vez por día).
  -- Si falla, la copia de pedidos no se deshace: queda anotado en el log.
  begin
    perform public.refrescar_chef_padron();
  exception when others then
    v_dif := concat_ws(' · ', v_dif, 'padrón falló: ' || sqlerrm);
  end;

$n$ || viejo;
  if position(viejo in d) = 0 then
    raise exception 'sincronizar_chef_orders: no encontré el log de éxito donde enganchar el padrón';
  end if;
  if (length(d) - length(replace(d, viejo, ''))) / length(viejo) <> 1 then
    raise exception 'sincronizar_chef_orders: el log de éxito aparece más de una vez';
  end if;
  execute replace(d, viejo, nuevo);
end $$;

-- Verificación:
--   select public.refrescar_chef_padron();                         -- → 0 (nada cambió desde la última corrida)
--   select position('refrescar_chef_padron' in pg_get_functiondef('public.sincronizar_chef_orders(integer)'::regprocedure)) > 0;
--   select corrida_en, ok, motivo, n_customers, ms from chef_cache_log order by id desc limit 3;   -- después de la próxima corrida
--   select count(*) from chef_padron;                               -- 766
