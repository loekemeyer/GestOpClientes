-- 082 — Aviso "pedido recibido" con FECHA ESTIMADA de salida (proyecto LK)
-- Pedido de Pablo Olejavetzky (29/09): "demora real por modo; después hacemos una estadística de cuánto se cumple".
--
-- Regla (medida el 29/09 sobre 365 pedidos web de 60 días, pedido → fecha de salida de la Programación):
--   · retira con día elegido en la web (sheets_payload.retiro_fecha/retiro_franja) → ese día: "lo retirás el …"
--   · si no: días = percentil 90 de la demora real de los últimos 90 días PARA ESE MODO (reparto ~21, expreso ~20,
--     retira ~8), se suma a la fecha del pedido y se corre al próximo hábil (dias_habiles_cache, criterio de Gestión).
--     Con menos de 20 pedidos del modo se usa el p90 de todos; sin datos, 14 días (promesa de Luis, get_fecha_listo).
-- Cada estimación queda en wa_fecha_estimada (para medir después cuánto se cumple contra order_tracking).
--
-- Además: el aviso sale cuando el pedido QUEDA ENVIADO (sheets_sent = true), no en cada INSERT. Antes, los intentos
-- fallidos de la web (sheets_sent = false, 27 en 60 días) también disparaban "Recibimos tu pedido".
-- Sigue pasando por wa_outbox y la llave wa_envio_automatico (D007). Plantilla pedido_recibido con {{5}}: editar en
-- Meta ANTES de aplicar esto (lk_templates templates_sync solo=['pedido_recibido']).
-- Rollback: definición anterior en zz_backups.bkp_trg_notify_order_created_20260929.

create table if not exists zz_backups.bkp_trg_notify_order_created_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'trg_notify_order_created';
alter table zz_backups.bkp_trg_notify_order_created_20260929 enable row level security;

create table if not exists public.wa_fecha_estimada (
  order_id    bigint primary key,
  modo        text not null,              -- reparto | expreso | retira
  fecha       date not null,              -- fecha estimada (o elegida por el cliente, si retira)
  regla       text not null,              -- p90_modo | p90_general | promesa_14 | elegida_cliente
  dias        integer,                    -- días corridos sumados a la fecha del pedido (null si elegida_cliente)
  muestra     integer,                    -- pedidos usados para el percentil
  texto       text not null,              -- lo que se le dijo al cliente
  creado_en   timestamptz not null default now()
);
alter table public.wa_fecha_estimada enable row level security;  -- sin políticas: sólo service_role

-- Próximo día hábil (>= p). Mismo criterio que get_fecha_listo: dias_habiles_cache y, si no cubre, salta el finde.
create or replace function public.wa_proximo_habil(p date)
 returns date language plpgsql stable set search_path to 'public' as $$
declare v date;
begin
  select min(c.fecha) into v from dias_habiles_cache c where c.fecha >= p and c.habil;
  if v is null or not exists (select 1 from dias_habiles_cache c where c.fecha = p) then
    v := p;
    while extract(dow from v) in (0, 6) loop v := v + 1; end loop;
  end if;
  return v;
end $$;

-- Fecha estimada de un pedido web. No escribe nada.
create or replace function public.wa_fecha_estimada_calc(p_order_id bigint)
 returns table(modo text, fecha date, regla text, dias integer, muestra integer, texto text)
 language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_base date; v_modo text; v_rfecha date; v_rfranja text; v_p90 numeric; v_n integer;
begin
  select (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
         nullif(btrim(o.sheets_payload ->> 'retiro_fecha'), '')::date,
         nullif(btrim(o.sheets_payload ->> 'retiro_franja'), '')
    into v_base, v_rfecha, v_rfranja
  from orders o where o.id = p_order_id;
  if v_base is null then return; end if;

  select case when v.zona_expreso ilike 'retira%' then 'retira'
              when coalesce(btrim(v.nombre_expreso), '') <> '' then 'expreso' else 'reparto' end
    into v_modo
  from v_pedidos_web v where v.order_id = p_order_id and v.linea_rn = 1 limit 1;
  v_modo := coalesce(v_modo, 'reparto');

  if v_modo = 'retira' and v_rfecha is not null and v_rfecha >= v_base then
    return query select v_modo, v_rfecha, 'elegida_cliente'::text, null::integer, null::integer,
      'lo retirás el ' || wa_fecha_con_dia(v_rfecha) || coalesce(', de ' || v_rfranja, '');
    return;
  end if;

  -- Demora real de los últimos 90 días (pedido → fecha de salida de la Programación), por modo.
  with d as (
    select case when v.zona_expreso ilike 'retira%' then 'retira'
                when coalesce(btrim(v.nombre_expreso), '') <> '' then 'expreso' else 'reparto' end m,
           t.fecha_entrega - (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date dias
    from orders o
    join order_tracking t on t.np_number = o.id::text
    join v_pedidos_web v on v.order_id = o.id and v.linea_rn = 1
    where o.created_at > now() - interval '90 days' and o.sheets_sent
      and t.status in ('programado', 'entregado') and t.fecha_entrega is not null)
  select percentile_cont(0.9) within group (order by d.dias), count(*) into v_p90, v_n from d where d.m = v_modo;

  if v_n >= 20 then
    regla := 'p90_modo';
  else
    select percentile_cont(0.9) within group (order by x.dias), count(*) into v_p90, v_n from (
      select t.fecha_entrega - (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date dias
      from orders o join order_tracking t on t.np_number = o.id::text
      where o.created_at > now() - interval '90 days' and o.sheets_sent
        and t.status in ('programado', 'entregado') and t.fecha_entrega is not null) x;
    regla := case when v_n >= 20 then 'p90_general' else 'promesa_14' end;
  end if;

  dias := case when regla = 'promesa_14' then 14 else ceil(v_p90)::integer end;
  modo := v_modo; muestra := v_n;
  fecha := wa_proximo_habil(v_base + dias);
  texto := case v_modo
    when 'retira'  then 'va a estar listo para retirar antes del ' || wa_fecha_con_dia(fecha)
    when 'expreso' then 'lo despachamos al expreso antes del ' || wa_fecha_con_dia(fecha)
    else 'sale antes del ' || wa_fecha_con_dia(fecha) end;
  return next;
end $$;

create or replace function public.trg_notify_order_created()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_phone text;
  v_customer_name text;
  v_est record;
BEGIN
  -- Sólo pedidos que quedaron enviados, y una sola vez por pedido.
  IF NOT coalesce(NEW.sheets_sent, false) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.sheets_sent, false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM wa_outbox WHERE context = 'order_created' AND ref_id = NEW.id::text) THEN RETURN NEW; END IF;

  -- La estimación se guarda siempre (aunque el cliente no esté agendado): es la base de la estadística.
  SELECT * INTO v_est FROM wa_fecha_estimada_calc(NEW.id);
  IF v_est.fecha IS NOT NULL THEN
    INSERT INTO wa_fecha_estimada (order_id, modo, fecha, regla, dias, muestra, texto)
    VALUES (NEW.id, v_est.modo, v_est.fecha, v_est.regla, v_est.dias, v_est.muestra, v_est.texto)
    ON CONFLICT (order_id) DO NOTHING;
  END IF;

  SELECT bcw.whatsapp, c.business_name
    INTO v_phone, v_customer_name
  FROM bot_customer_whatsapps bcw
  JOIN customers c ON c.id = bcw.customer_id
  WHERE bcw.customer_id = NEW.customer_id
  ORDER BY bcw.is_primary DESC, bcw.created_at DESC
  LIMIT 1;
  IF v_phone IS NULL THEN RETURN NEW; END IF;

  INSERT INTO wa_outbox (phone, template_name, template_params, context, ref_id)
  VALUES (
    v_phone,
    'pedido_recibido',
    jsonb_build_object(
      '1', coalesce(nullif(btrim(v_customer_name), ''), 'cliente'),
      '2', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM'),
      '3', '$' || replace(to_char(round(coalesce(NEW.total, 0)), 'FM999G999G999'), ',', '.'),
      '4', wa_metodo_pago_texto(NEW.payment_method),
      '5', coalesce(v_est.texto, 'te la confirmamos cuando entre en programación')),
    'order_created',
    NEW.id::text
  );

  PERFORM net.http_post(
    url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_notify_order_created falló: %', SQLERRM;
  RETURN NEW;
END;
$function$;

drop trigger if exists orders_notify_whatsapp on public.orders;
create trigger orders_notify_whatsapp
  after insert or update of sheets_sent on public.orders
  for each row execute function public.trg_notify_order_created();

-- Verificación (sólo lectura):
--   select o.id, e.* from orders o, wa_fecha_estimada_calc(o.id) e where o.sheets_sent order by o.id desc limit 10;
-- Estadística de cumplimiento (cuando haya datos):
--   select e.modo, e.regla, count(*), round(100.0 * avg((t.fecha_entrega <= e.fecha)::int), 1) pct_cumple
--   from wa_fecha_estimada e join order_tracking t on t.np_number = e.order_id::text
--   where t.fecha_entrega is not null group by 1, 2;
