-- 072 — Vinculación teléfono WhatsApp → cliente: SIEMPRE con revisión humana (proyecto LK)
-- Pedido de Pablo Olejavetzky (25/09, Planify «Aprobación humana de teléfonos nuevos en dashboard»).
--
-- Problema: bot_register_request_v2 auto-vinculaba como PRINCIPAL a cualquier número que escribiera
-- un CUIT válido, si el cliente todavía no tenía principal. El CUIT es público (facturas, padrón).
-- Además copiaba el teléfono a customers.whatsapp, que wa_identify_customer usa para identificar.
--
-- Ahora:
--   1. Número nuevo + CUIT de un cliente → solicitud 'pending' (tipo 'registro'). No se vincula nada
--      ni se toca customers.whatsapp hasta que un humano la apruebe desde el dashboard
--      (Panel de Control → Vinculaciones, edge lk_vinculaciones → bot_register_decide).
--   2. Tope de intentos: un número que ya probó 3 CUITs distintos en 24 h → 'too_many_attempts'.
--   3. bot_register_decide: el aprobado queda principal sólo si el cliente no tenía uno (antes
--      siempre is_primary=true) y sólo en ese caso pisa customers.whatsapp. Si ya había principal,
--      se le encola un aviso "se vinculó un número nuevo" en wa_outbox (sale detrás de la llave
--      wa_envio_automatico, principio D007).
--   4. bot_register_pending devuelve además: principal actual, teléfonos del ERP del cliente e
--      intentos del número en 24 h, para que quien revisa pueda llamar y confirmar.
--
-- No cambia: la identificación por padrón del ERP (wa_identify_customer → wa_clientes_telefono),
-- 'already_registered', 'cuit_not_found' (alta de cliente nuevo) ni el flujo 'pedidos_access'.
-- bot_register_decide_by_primary queda para solicitudes 'pending_primary' viejas (hoy hay 0).

-- 1) Solicitud de vinculación: nunca auto-asocia ─────────────────────────────────────────────
create or replace function public.bot_register_request_v2(p_telefono text, p_cuit text)
 returns table(request_id bigint, status text, business_name text, cod_cliente integer, primary_phone text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_norm text;
  v_id uuid;
  v_cod integer;
  v_name text;
  v_already uuid;
  v_pending_id bigint;
  v_req_id bigint;
  v_primary text;
  v_intentos int;
BEGIN
  v_norm := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
  IF length(v_norm) < 10 OR length(v_norm) > 13 THEN RETURN; END IF;

  -- Teléfono ya asociado a algún customer -> salir
  SELECT cw.customer_id, c.business_name, c.cod_cliente
    INTO v_already, v_name, v_cod
  FROM public.bot_customer_whatsapps cw
  JOIN public.customers c ON c.id = cw.customer_id
  WHERE cw.whatsapp = p_telefono
  LIMIT 1;
  IF v_already IS NOT NULL THEN
    request_id := 0; status := 'already_registered';
    business_name := v_name; cod_cliente := v_cod; primary_phone := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- Tope: 3 CUITs distintos por número en 24 h (evita probar CUITs hasta pegarle a uno).
  SELECT count(DISTINCT r.cuit_normalizado) INTO v_intentos
  FROM public.bot_registration_requests r
  WHERE r.telefono = p_telefono
    AND r.creado_en > now() - interval '24 hours'
    AND r.cuit_normalizado IS DISTINCT FROM v_norm;
  IF v_intentos >= 3 THEN
    request_id := 0; status := 'too_many_attempts';
    business_name := NULL; cod_cliente := NULL; primary_phone := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- Buscar customer por CUIT
  SELECT c.id, c.cod_cliente, c.business_name
    INTO v_id, v_cod, v_name
  FROM public.customers c
  WHERE regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') = v_norm
  LIMIT 1;
  IF v_id IS NULL THEN
    request_id := 0; status := 'cuit_not_found';
    business_name := NULL; cod_cliente := NULL; primary_phone := NULL;
    RETURN NEXT; RETURN;
  END IF;

  SELECT cw.whatsapp INTO v_primary
  FROM public.bot_customer_whatsapps cw
  WHERE cw.customer_id = v_id AND cw.is_primary = true
  LIMIT 1;

  -- Siempre a revisión humana. Una sola solicitud abierta por número: si ya hay, se actualiza.
  SELECT r.id INTO v_pending_id
  FROM public.bot_registration_requests r
  WHERE r.telefono = p_telefono
    AND r.status IN ('pending', 'pending_primary', 'timeout_to_inbox')
    AND coalesce(r.tipo, 'registro') = 'registro'
  LIMIT 1;

  IF v_pending_id IS NOT NULL THEN
    UPDATE public.bot_registration_requests
    SET cuit_normalizado = v_norm, customer_id = v_id, cod_cliente = v_cod,
        business_name = v_name, status = 'pending', tipo = 'registro',
        notified_primary_phone = v_primary, creado_en = now()
    WHERE id = v_pending_id;
    v_req_id := v_pending_id;
  ELSE
    INSERT INTO public.bot_registration_requests
      (telefono, cuit_normalizado, customer_id, cod_cliente, business_name, status, tipo,
       notified_primary_phone)
    VALUES (p_telefono, v_norm, v_id, v_cod, v_name, 'pending', 'registro', v_primary)
    RETURNING id INTO v_req_id;
  END IF;

  request_id := v_req_id; status := 'pending_review';
  business_name := v_name; cod_cliente := v_cod; primary_phone := v_primary;
  RETURN NEXT;
END;
$function$;

-- 2) Decisión humana ──────────────────────────────────────────────────────────────────────────
create or replace function public.bot_register_decide(p_request_id bigint, p_decision text, p_agente text, p_motivo text)
 returns table(ok boolean, status text, telefono text, business_name text, tipo text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_req record;
  v_primary text;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    ok := false; status := 'invalid_decision'; tipo := NULL;
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO v_req FROM public.bot_registration_requests WHERE id = p_request_id;
  IF v_req.id IS NULL THEN
    ok := false; status := 'not_found'; tipo := NULL;
    RETURN NEXT; RETURN;
  END IF;

  IF v_req.status NOT IN ('pending','timeout_to_inbox') THEN
    ok := false; status := v_req.status;
    telefono := v_req.telefono; business_name := v_req.business_name; tipo := v_req.tipo;
    RETURN NEXT; RETURN;
  END IF;

  IF p_decision = 'approve' THEN
    IF v_req.tipo = 'pedidos_access' THEN
      UPDATE public.bot_customer_whatsapps
        SET permiso_ver_pedidos = true
        WHERE whatsapp = v_req.telefono;
    ELSE
      SELECT cw.whatsapp INTO v_primary
      FROM public.bot_customer_whatsapps cw
      WHERE cw.customer_id = v_req.customer_id AND cw.is_primary = true
      LIMIT 1;

      IF v_primary IS NULL THEN
        -- Primer número del cliente: queda principal y es el que identifica (customers.whatsapp).
        UPDATE public.customers SET whatsapp = NULL
          WHERE whatsapp = v_req.telefono AND id <> v_req.customer_id;
        UPDATE public.customers SET whatsapp = v_req.telefono
          WHERE id = v_req.customer_id;
      ELSE
        -- Ya tenía principal: el nuevo entra como secundario y se le avisa al principal.
        INSERT INTO public.wa_outbox (phone, body, context, ref_id)
        VALUES (v_primary,
                'Hola ' || coalesce(v_req.business_name, '') || ', te escribimos de Loekemeyer.' || E'\n' ||
                'Se vinculó a tu cuenta el número terminado en ' || right(v_req.telefono, 4) ||
                '. Si no lo reconocés, respondé NO a este mensaje.',
                'vinculacion_aviso_principal', v_req.id::text);
      END IF;

      INSERT INTO public.bot_customer_whatsapps (customer_id, cod_cliente, whatsapp, is_primary, empresa)
      VALUES (v_req.customer_id, v_req.cod_cliente, v_req.telefono, v_primary IS NULL, 'LK')
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE public.bot_registration_requests
      SET status = 'approved', agente_nombre = p_agente,
          accion_motivo = p_motivo, accion_en = now()
      WHERE id = p_request_id;
    ok := true; status := 'approved';
    telefono := v_req.telefono; business_name := v_req.business_name; tipo := v_req.tipo;
    RETURN NEXT; RETURN;
  END IF;

  UPDATE public.bot_registration_requests
    SET status = 'rejected', agente_nombre = p_agente,
        accion_motivo = p_motivo, accion_en = now()
    WHERE id = p_request_id;
  ok := true; status := 'rejected';
  telefono := v_req.telefono; business_name := v_req.business_name; tipo := v_req.tipo;
  RETURN NEXT;
END;
$function$;

-- 3) Cola para revisar, con datos para verificar ─────────────────────────────────────────────
-- Cambia el tipo de retorno (columnas nuevas al final): hay que dropear. La usa inbox-register
-- (passthrough del JSON: columnas de más no rompen) y lk_vinculaciones.
drop function if exists public.bot_register_pending();
create function public.bot_register_pending()
 returns table(id bigint, telefono text, cuit_normalizado text, cod_cliente integer, business_name text,
               creado_en timestamptz, was_timeout boolean, tipo text, current_whatsapp text,
               principal_actual text, telefonos_erp text[], intentos_24h integer)
 language sql
 security definer
 set search_path to 'public'
as $function$
  SELECT r.id, r.telefono, r.cuit_normalizado, r.cod_cliente, r.business_name, r.creado_en,
         (r.status = 'timeout_to_inbox') AS was_timeout, r.tipo, c.whatsapp AS current_whatsapp,
         (SELECT cw.whatsapp FROM public.bot_customer_whatsapps cw
           WHERE cw.customer_id = r.customer_id AND cw.is_primary LIMIT 1) AS principal_actual,
         (SELECT array_agg(DISTINCT wc.telefono) FROM public.wa_clientes_telefono wc
           WHERE wc.cod_cliente = r.cod_cliente::text) AS telefonos_erp,
         (SELECT count(DISTINCT r2.cuit_normalizado)::int FROM public.bot_registration_requests r2
           WHERE r2.telefono = r.telefono AND r2.creado_en > now() - interval '24 hours') AS intentos_24h
  FROM public.bot_registration_requests r
  LEFT JOIN public.customers c ON c.cod_cliente = r.cod_cliente
  WHERE r.status IN ('pending', 'timeout_to_inbox')
  ORDER BY r.creado_en DESC
  LIMIT 100;
$function$;

revoke all on function public.bot_register_pending() from public, anon, authenticated;
revoke all on function public.bot_register_decide(bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_register_request_v2(text, text) from public, anon, authenticated;

-- Verificación:
--   select pg_get_functiondef('public.bot_register_request_v2(text,text)'::regprocedure) ~ 'auto_associated';  -- false
--   select * from public.bot_register_pending();
-- Rollback: volver a aplicar las definiciones anteriores (pg_get_functiondef guardado antes de aplicar
--   en zz_backups, ver el paso previo de la sesión).
