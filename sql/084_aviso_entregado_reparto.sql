-- 084 — Aviso "pedido entregado" para reparto propio (proyecto LK)
-- Pedido de Pablo Olejavetzky (29/09): el reparto lleva dos avisos, "uno cuando se facture y otro cuando se recibe".
-- Al facturar ya sale la factura (lk_factura-check, plantillas pedido_{contado|credito|echeq}_{s|p}); al recibir
-- no salía nada: pedido_entregado estaba aprobada en Meta pero sin disparador.
--
-- trg_order_tracking_notify (sql/079): cuando order_tracking pasa a 'entregado' y el pedido es de REPARTO propio →
-- pedido_entregado {razón social, pedido del dd/mm}, una sola vez por pedido (context 'tracking_entregado', igual que
-- el de expreso). Expreso sigue con pedido_en_viaje_expreso; retiro no se avisa (se lo lleva el cliente).
-- Verificado el 29/09: los 64 pedidos web que Gestión da por entregados figuran 'entregado' en order_tracking y no
-- hay pedidos con fecha de salida vencida sin entregar.
-- Rollback: zz_backups.bkp_trg_order_tracking_notify_20260929.

create table if not exists zz_backups.bkp_trg_order_tracking_notify_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'trg_order_tracking_notify';
alter table zz_backups.bkp_trg_order_tracking_notify_20260929 enable row level security;

create or replace function public.trg_order_tracking_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_fecha_pedido text;
  v_status_cambio boolean := (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status);
  v_tpl text;
  v_params jsonb;
  v_ctx text;
  v_modo text;
  v_expreso text;
BEGIN
  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.cod_cliente = NEW.cod_cliente
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  SELECT to_char(o.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM')
    INTO v_fecha_pedido
  FROM orders o WHERE o.id::text = NEW.np_number;

  SELECT CASE WHEN v.zona_expreso ILIKE 'retira%' THEN 'retira'
              WHEN coalesce(btrim(v.nombre_expreso), '') <> '' THEN 'expreso'
              ELSE 'reparto' END,
         nullif(btrim(v.nombre_expreso), '')
    INTO v_modo, v_expreso
  FROM v_pedidos_web v WHERE v.order_id::text = NEW.np_number AND v.linea_rn = 1
  LIMIT 1;
  v_modo := coalesce(v_modo, 'reparto');

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_ctx := 'tracking_programado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
    IF v_modo = 'retira' THEN
      v_tpl := 'pedido_programado_retira';
    ELSIF v_modo = 'expreso' THEN
      v_tpl := 'pedido_programado_expreso';
      v_params := v_params || jsonb_build_object('4', v_expreso);
    ELSE
      v_tpl := 'pedido_programado';
    END IF;
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_tpl := 'pedido_reprogramado'; v_ctx := 'tracking_fecha_cambio';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
  ELSIF TG_OP = 'UPDATE' AND v_status_cambio AND NEW.status = 'entregado' AND v_modo IN ('expreso', 'reparto')
        AND NOT EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'tracking_entregado' AND ref_id = NEW.np_number) THEN
    v_ctx := 'tracking_entregado';
    IF v_modo = 'expreso' THEN
      v_tpl := 'pedido_en_viaje_expreso';
      v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
        '2', coalesce(v_fecha_pedido, 'reciente'), '3', v_expreso);
    ELSE
      v_tpl := 'pedido_entregado';
      v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
        '2', coalesce(v_fecha_pedido, 'reciente'));
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
  VALUES (v_phone, v_tpl, v_params, v_ctx, NEW.np_number);

  PERFORM net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 15000);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_order_tracking_notify falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;
