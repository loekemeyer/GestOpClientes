-- 166 — Reenganche de la entrega: el expreso recibe su propio aviso "recibido por el expreso"
-- (Pablo Olejavetzky, 16/10/2026: "el pedido tiene que disparar cuando esté en viaje y cuando el
--  remito aparezca como entregado. en todos los casos").
--
-- Qué cambiaba y por qué: hasta hoy el expreso recibía SOLO el aviso "en viaje" y nunca el de
-- "recibido". Causa: el cron wa_avisos_en_viaje_web (sql/106) encolaba pedido_en_viaje_expreso con
-- context 'tracking_entregado' justamente para que trg_order_tracking_notify NO repitiera al
-- marcarse "entregado"; y además, en su rama 'entregado', el trigger mandaba pedido_en_viaje_expreso
-- (la vieja) en vez de pedido_en_expreso. Resultado: un solo aviso para el expreso.
--
-- Ahora, en los tres modos hay dos momentos:
--   · en viaje   → reparto: pedido_en_viaje ; expreso: pedido_en_viaje_expreso (context en_viaje_web)
--   · entregado  → retira: pedido_retirado ; reparto: pedido_entregado ; expreso: pedido_en_expreso
-- (retira no tiene "en viaje": es retiro en depósito.)
--
-- Dos cambios:
--  1) wa_avisos_en_viaje_web: el "en viaje" del expreso pasa de context 'tracking_entregado' a
--     'en_viaje_web', así deja de suprimir al trigger. El dedup sigue mirando ambos contexts.
--  2) trg_order_tracking_notify: rama 'entregado', modo expreso → pedido_en_expreso (antes
--     pedido_en_viaje_expreso). Mismos params {1: fecha del pedido, 2: expreso sin "Expreso"}.
--
-- De paso, esta migración captura en el repo el trigger que vivía sólo en la base (el mapeo
-- retira→pedido_retirado se había aplicado directo, sin migración: sql/160 del repo es otra cosa).
--
-- Dependencia abierta (lado de Luis): el trigger sigue disparando por el 'entregado' de Gestión
-- (gv_pedido_web_estado_pagina.entregado, que se marca al día siguiente ~08:00). Cuando Virgilio
-- exponga la marca del remito, esa marca es la que debe prender ese 'entregado' (opción A de
-- docs/REENGANCHE-REMITO-VIRGILIO.md). Este cambio es del lado de PaginaLK; no necesita a Virgilio
-- para andar con el estado de Gestión como fuente.
--
-- Rollback: volver a la definición de sql/106 (cron) y a la de sql/094+sql/160 (trigger: expreso →
-- pedido_en_viaje_expreso con context tracking_entregado en el cron).

-- 1) Cron: el "en viaje" del expreso no bloquea más al trigger de "entregado".
create or replace function public.wa_avisos_en_viaje_web()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; r record;
begin
  for r in
    select o.id, bcw.whatsapp phone,
           to_char(o.created_at at time zone 'America/Argentina/Buenos_Aires', 'DD/MM') fecha_pedido,
           nullif(btrim(v.sucursal_entrega), '') direccion,
           nullif(btrim(v.nombre_expreso), '') expreso
    from virgilio.gv_pedido_web_estado_pagina e
    join orders o on o.id = e.order_id
    join customers c on c.id = o.customer_id
    join lateral (select b.whatsapp from bot_customer_whatsapps b where b.customer_id = c.id
                  order by b.is_primary desc, b.created_at desc limit 1) bcw on true
    join v_pedidos_web v on v.order_id = o.id and v.linea_rn = 1
    where e.empresa = 'lk' and e.estado = 'facturado' and not coalesce(e.entregado, false)
      and e.fecha_entrega = (now() at time zone 'America/Argentina/Buenos_Aires')::date
      and o.sheets_sent and o.created_at > now() - interval '60 days'
      and coalesce(v.zona_expreso, '') not ilike 'retira%'
      and not exists (select 1 from wa_outbox w where w.ref_id = o.id::text
                        and w.context in ('en_viaje_web', 'tracking_entregado'))
  loop
    if r.expreso is not null then
      insert into wa_outbox (phone, template_name, template_params, context, ref_id)
      values (r.phone, 'pedido_en_viaje_expreso',
              jsonb_build_object('1', r.fecha_pedido, '2', regexp_replace(r.expreso, '^\s*expreso\s+', '', 'i')),
              'en_viaje_web', r.id::text);  -- sql/168: era 'tracking_entregado'
    else
      insert into wa_outbox (phone, template_name, template_params, context, ref_id)
      values (r.phone, 'pedido_en_viaje',
              jsonb_build_object('1', r.fecha_pedido, '2', coalesce(r.direccion, 'tu dirección de entrega')),
              'en_viaje_web', r.id::text);
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_en_viaje_web falló: %', sqlerrm;
  return -1;
end $$;

-- 2) Trigger: al marcarse "entregado", el expreso manda pedido_en_expreso ("recibido por el expreso").
create or replace function public.trg_order_tracking_notify()
 returns trigger language plpgsql security definer set search_path to 'public' as $$
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
  v_dir text;
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
         nullif(btrim(v.nombre_expreso), ''), nullif(btrim(v.sucursal_entrega), '')
    INTO v_modo, v_expreso, v_dir
  FROM v_pedidos_web v WHERE v.order_id::text = NEW.np_number AND v.linea_rn = 1
  LIMIT 1;
  v_modo := coalesce(v_modo, 'reparto');

  IF v_status_cambio AND NEW.status = 'programado' AND NEW.fecha_entrega IS NOT NULL THEN
    v_ctx := 'tracking_programado';
    v_params := jsonb_build_object('1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', coalesce(v_fecha_pedido, 'reciente'), '3', wa_fecha_con_dia(NEW.fecha_entrega));
    IF v_modo = 'retira' THEN
      v_tpl := 'pedido_programado_retira';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092
    ELSIF v_modo = 'expreso' THEN
      v_tpl := 'pedido_programado_expreso';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega),
        '3', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));
    ELSE
      v_tpl := 'pedido_programado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega),
        '3', coalesce(v_dir, 'tu dirección de entrega'));
    END IF;
  ELSIF NOT v_status_cambio AND NEW.status = 'programado'
        AND OLD.fecha_entrega IS NOT NULL AND NEW.fecha_entrega IS NOT NULL
        AND OLD.fecha_entrega IS DISTINCT FROM NEW.fecha_entrega THEN
    v_tpl := 'pedido_reprogramado'; v_ctx := 'tracking_fecha_cambio';
    v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'), '2', wa_fecha_con_dia(NEW.fecha_entrega));  -- sql/092
  ELSIF TG_OP = 'UPDATE' AND v_status_cambio AND NEW.status = 'entregado' AND v_modo IN ('expreso', 'reparto', 'retira')
        AND NOT EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'tracking_entregado' AND ref_id = NEW.np_number) THEN
    v_ctx := 'tracking_entregado';
    IF v_modo = 'expreso' THEN
      v_tpl := 'pedido_en_expreso';  -- sql/168: era pedido_en_viaje_expreso; ahora "recibido por el expreso"
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'),
        '2', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));
    ELSIF v_modo = 'retira' THEN
      v_tpl := 'pedido_retirado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));  -- sql/160 (capturado en repo acá)
    ELSE
      v_tpl := 'pedido_entregado';
      v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));  -- sql/094
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
$$;
