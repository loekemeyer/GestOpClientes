-- Recordatorio a 10 días: "se está por vencer el plazo para el 25% (pago contado)".
-- Base = fecha_salida (día que sale el pedido, guardado en bot_facturado_avisos). Dispara a los
-- 10 días (con 3 de gracia por si el cron se saltea un día). Para TODOS los clientes con aviso
-- de facturado. Dedup por recordatorio_25_at. Encola en wa_outbox con template.
-- fecha_limite del 25% = fecha_salida + 14.
-- ⚠ MODO PRUEBA: v_test_phone redirige TODO a un solo número; "" para producción (cliente real).
-- La corre pg_cron 1×/día. Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg).

CREATE OR REPLACE FUNCTION public.bot_encolar_recordatorios_25()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
declare
  v_test_phone text := '5491162521635';   -- MODO PRUEBA: "" para producción (manda al cliente real)
  r     record;
  v_ph  text;
  v_dst text;
  n     int := 0;
begin
  for r in
    select np, cod_cliente, fecha_salida, (fecha_salida + 14) as fecha_limite
    from public.bot_facturado_avisos
    where recordatorio_25_at is null
      and fecha_salida is not null
      and (current_date - fecha_salida) between 10 and 13
    order by fecha_salida
    limit 500
  loop
    v_ph := null;
    select whatsapp into v_ph
      from public.bot_customer_whatsapps
     where cod_cliente::text = r.cod_cliente and whatsapp is not null
     order by is_primary desc nulls last
     limit 1;
    if v_ph is null then
      select telefono into v_ph from public.wa_clientes_telefono where cod_cliente = r.cod_cliente limit 1;
    end if;

    v_dst := coalesce(nullif(v_test_phone, ''), regexp_replace(coalesce(v_ph, ''), '\D', '', 'g'));

    if v_dst is null or v_dst = ''
       or exists (select 1 from public.wa_blacklist where phone = v_dst) then
      update public.bot_facturado_avisos set recordatorio_25_at = now() where np = r.np;
      continue;
    end if;

    insert into public.wa_outbox (phone, template_name, template_params, status)
    values (v_dst, 'pedido_recordatorio_25',
            jsonb_build_object('1', r.np, '2', to_char(r.fecha_limite, 'DD/MM/YYYY')),
            'pending');
    update public.bot_facturado_avisos set recordatorio_25_at = now() where np = r.np;
    n := n + 1;
  end loop;
  return n;
end;
$function$;

-- Cron diario 09:00 ART (12:00 UTC). Idempotente: unschedule previo si existe.
SELECT cron.unschedule('bot-recordatorio-25')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'bot-recordatorio-25');
SELECT cron.schedule('bot-recordatorio-25', '0 12 * * *', 'select public.bot_encolar_recordatorios_25()');
