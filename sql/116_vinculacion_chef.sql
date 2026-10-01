-- 116 — Vinculación de teléfonos de clientes de Chef, con revisión humana (igual que LK desde sql/072)
-- Pedido de Pablo Olejavetzky (01/10). Sigue a sql/115.
--
-- Antes: un cliente que sólo le compra a Chef (395 CUIT al 01/10) escribía su CUIT, bot_register_request_v2 lo buscaba
-- sólo en customers (LK), contestaba cuit_not_found y el bot le arrancaba el ALTA como si fuera un cliente nuevo.
-- Ahora:
--   · bot_registration_requests.empresa ('LK' | 'CH').
--   · bot_register_request_v2: si el CUIT no está en LK pero sí en chef_padron, queda una solicitud de Chef pendiente
--     de revisión (pending_review), con el código y la razón social de Chef. Si ya está vinculado a Chef,
--     already_registered.
--   · bot_register_decide: aprobar una solicitud de Chef la carga en bot_chef_whatsapps (NO en bot_customer_whatsapps ni
--     en customers.whatsapp: ver sql/115 punto 4). Las de LK siguen igual.
--   · bot_register_pending (lista del dashboard): devuelve la empresa; en las de Chef el "teléfono en Gestión" sale del
--     padrón de Chef y no hay "principal actual" (antes cruzaba customers por cod_cliente: con un código de Chef
--     mostraba los teléfonos del cliente de LK con el mismo número).
-- Rollback: zz_backups.bkp_vinculacion_20261001.

create table if not exists zz_backups.bkp_vinculacion_20261001 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('bot_register_request_v2', 'bot_register_decide', 'bot_register_pending');
alter table zz_backups.bkp_vinculacion_20261001 enable row level security;

alter table public.bot_registration_requests
  add column if not exists empresa text not null default 'LK';
do $$ begin
  alter table public.bot_registration_requests
    add constraint bot_registration_requests_empresa_check check (empresa in ('LK', 'CH'));
exception when duplicate_object then null; end $$;

-- bot_register_request_v2 ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bot_register_request_v2(p_telefono text, p_cuit text)
 RETURNS TABLE(request_id bigint, status text, business_name text, cod_cliente integer, primary_phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_empresa text := 'LK';
  v_chef_cod text;
BEGIN
  v_norm := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
  IF length(v_norm) < 10 OR length(v_norm) > 13 THEN RETURN; END IF;

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

  -- sql/116: ya vinculado a una cuenta de Chef.
  SELECT w.cod_cliente, coalesce(p.business_name, w.razon_social)
    INTO v_chef_cod, v_name
  FROM public.bot_chef_whatsapps w
  LEFT JOIN public.chef_padron p ON p.cod_cliente = w.cod_cliente
  WHERE right(regexp_replace(w.whatsapp, '\D', '', 'g'), 10) = right(regexp_replace(p_telefono, '\D', '', 'g'), 10)
  ORDER BY w.created_at DESC
  LIMIT 1;
  IF v_chef_cod IS NOT NULL THEN
    request_id := 0; status := 'already_registered';
    business_name := v_name; cod_cliente := v_chef_cod::integer; primary_phone := NULL;
    RETURN NEXT; RETURN;
  END IF;

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

  SELECT c.id, c.cod_cliente, c.business_name
    INTO v_id, v_cod, v_name
  FROM public.customers c
  WHERE regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') = v_norm
  LIMIT 1;

  IF v_id IS NULL THEN
    -- sql/116: no es cliente de LK; ¿es cliente de Chef? (el mismo CUIT puede tener más de una cuenta: la de menor código)
    SELECT p.cod_cliente::integer, p.business_name
      INTO v_cod, v_name
    FROM public.chef_padron p
    WHERE regexp_replace(coalesce(p.cuit, ''), '\D', '', 'g') = v_norm
    ORDER BY p.cod_cliente::integer
    LIMIT 1;
    IF v_cod IS NULL THEN
      request_id := 0; status := 'cuit_not_found';
      business_name := NULL; cod_cliente := NULL; primary_phone := NULL;
      RETURN NEXT; RETURN;
    END IF;
    v_empresa := 'CH';
  END IF;

  IF v_empresa = 'LK' THEN
    SELECT cw.whatsapp INTO v_primary
    FROM public.bot_customer_whatsapps cw
    WHERE cw.customer_id = v_id AND cw.is_primary = true
    LIMIT 1;
  END IF;

  SELECT r.id INTO v_pending_id
  FROM public.bot_registration_requests r
  WHERE r.telefono = p_telefono
    AND r.status IN ('pending', 'pending_primary', 'timeout_to_inbox')
    AND coalesce(r.tipo, 'registro') = 'registro'
  LIMIT 1;

  IF v_pending_id IS NOT NULL THEN
    UPDATE public.bot_registration_requests
    SET cuit_normalizado = v_norm, customer_id = v_id, cod_cliente = v_cod,
        business_name = v_name, status = 'pending', tipo = 'registro', empresa = v_empresa,
        notified_primary_phone = v_primary, creado_en = now()
    WHERE id = v_pending_id;
    v_req_id := v_pending_id;
  ELSE
    INSERT INTO public.bot_registration_requests
      (telefono, cuit_normalizado, customer_id, cod_cliente, business_name, status, tipo, empresa,
       notified_primary_phone)
    VALUES (p_telefono, v_norm, v_id, v_cod, v_name, 'pending', 'registro', v_empresa, v_primary)
    RETURNING id INTO v_req_id;
  END IF;

  request_id := v_req_id; status := 'pending_review';
  business_name := v_name; cod_cliente := v_cod; primary_phone := v_primary;
  RETURN NEXT;
END;
$function$;

-- bot_register_decide ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bot_register_decide(p_request_id bigint, p_decision text, p_agente text, p_motivo text)
 RETURNS TABLE(ok boolean, status text, telefono text, business_name text, tipo text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    IF coalesce(v_req.empresa, 'LK') = 'CH' THEN
      -- sql/116: cuenta de Chef → bot_chef_whatsapps. No toca customers ni bot_customer_whatsapps (son de LK).
      INSERT INTO public.bot_chef_whatsapps (whatsapp, cod_cliente, cuit, razon_social, request_id, aprobado_por)
      VALUES (v_req.telefono, v_req.cod_cliente::text, v_req.cuit_normalizado, v_req.business_name, v_req.id, p_agente)
      ON CONFLICT (whatsapp, cod_cliente) DO NOTHING;
    ELSIF v_req.tipo = 'pedidos_access' THEN
      UPDATE public.bot_customer_whatsapps
        SET permiso_ver_pedidos = true
        WHERE whatsapp = v_req.telefono;
    ELSE
      SELECT cw.whatsapp INTO v_primary
      FROM public.bot_customer_whatsapps cw
      WHERE cw.customer_id = v_req.customer_id AND cw.is_primary = true
      LIMIT 1;

      IF v_primary IS NULL THEN
        UPDATE public.customers SET whatsapp = NULL
          WHERE whatsapp = v_req.telefono AND id <> v_req.customer_id;
        UPDATE public.customers SET whatsapp = v_req.telefono
          WHERE id = v_req.customer_id;
      ELSE
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

-- bot_register_pending (cambia el tipo de salida: se agrega empresa → drop + create) -----------------------------------
DROP FUNCTION IF EXISTS public.bot_register_pending();
CREATE FUNCTION public.bot_register_pending()
 RETURNS TABLE(id bigint, telefono text, cuit_normalizado text, cod_cliente integer, business_name text,
               creado_en timestamp with time zone, was_timeout boolean, tipo text, current_whatsapp text,
               principal_actual text, telefonos_erp text[], intentos_24h integer, empresa text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.id, r.telefono, r.cuit_normalizado, r.cod_cliente, r.business_name, r.creado_en,
         (r.status = 'timeout_to_inbox') AS was_timeout, r.tipo,
         CASE WHEN r.empresa = 'LK' THEN c.whatsapp END AS current_whatsapp,
         CASE WHEN r.empresa = 'LK' THEN
           (SELECT cw.whatsapp FROM public.bot_customer_whatsapps cw
             WHERE cw.customer_id = r.customer_id AND cw.is_primary LIMIT 1) END AS principal_actual,
         CASE WHEN r.empresa = 'CH' THEN
           (SELECT array_agg(DISTINCT t.telefono) FROM public.bot_telefonos_empresa t
             WHERE t.empresa = 'CH' AND t.cod_cliente = r.cod_cliente::text)
         ELSE
           (SELECT array_agg(DISTINCT wc.telefono) FROM public.wa_clientes_telefono wc
             WHERE wc.cod_cliente = r.cod_cliente::text) END AS telefonos_erp,
         (SELECT count(DISTINCT r2.cuit_normalizado)::int FROM public.bot_registration_requests r2
           WHERE r2.telefono = r.telefono AND r2.creado_en > now() - interval '24 hours') AS intentos_24h,
         r.empresa
  FROM public.bot_registration_requests r
  LEFT JOIN public.customers c ON c.cod_cliente = r.cod_cliente AND r.empresa = 'LK'
  WHERE r.status IN ('pending', 'timeout_to_inbox')
  ORDER BY r.creado_en DESC
  LIMIT 100;
$function$;
REVOKE ALL ON FUNCTION public.bot_register_pending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_register_pending() TO service_role;
