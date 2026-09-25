-- 068 — Llave general de envíos automáticos de WhatsApp (proyecto LK kwkclwhmoygunqmlegrg)
-- Pedido de Luis, 2026-09-25: "debería tener un switch de no mandar nada como otra barrera de
-- protección" · "no debería tener acceso a ningún teléfono más que los que se cargaron de prueba".
--
-- ESTADO: APLICADO el 2026-09-25 con el "sí" de Luis.
--
-- Medido el 25/09 antes de escribir esto:
--   * Los que despachan solos son DOS: lk_outbox-flush (lee wa_outbox vía bot_flush_outbox) y
--     notify-tracking-status (lee bot_pending_notifications y manda a customers.whatsapp).
--     NINGUNO mira la whitelist (wa_envio_contactos): hoy la barrera es que las tablas de teléfonos
--     del bot están vacías (bot_customer_whatsapps = 0 filas).
--   * wa_clientes_telefono tiene 963 teléfonos de clientes reales. La leen
--     bot_encolar_recordatorios_25 (frenado sólo por v_test_phone hardcodeado) y
--     bot_reactivar_inactivos (frenado por bot_reactivacion_config.enabled = false).
--   * customers.whatsapp: 8 números.
--
-- Diseño: la llave vive en el ÚLTIMO paso (el que despacha), no en cada productor. Un productor
-- nuevo que se olvide de chequearla igual no llega a mandar nada.
--   app_settings.wa_envio_automatico = '0'       → no sale NADA (los mensajes quedan en cola)
--                                    = 'prueba'  → sólo a números de wa_envio_contactos;
--                                                  el resto queda 'held_no_whitelist'
--                                    = '1'       → producción, a todos
-- FAIL-CLOSED: sin la fila, o con cualquier otro valor, cuenta como '0'.

insert into public.app_settings (key, value)
values ('wa_envio_automatico', '0')
on conflict (key) do nothing;

create or replace function public.bot_flush_outbox(p_limit integer default 20)
 returns table(id bigint, phone text, body text, template_name text, template_params jsonb)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_modo text := coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0');
begin
  -- Llave general (068): apagada → no despacha nada, la cola queda como está.
  if v_modo not in ('prueba', '1') then
    return;
  end if;

  -- Modo prueba: lo que no va a un número de prueba se retiene y no se reintenta.
  if v_modo = 'prueba' then
    update wa_outbox o
       set status = 'held_no_whitelist'
     where o.status = 'pending'
       and not exists (select 1 from wa_envio_contactos c
                        where regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(o.phone, '\D', '', 'g'));
  end if;

  return query
  with batch as (
    select o.id
    from wa_outbox o
    where o.status = 'pending'
      and o.attempts < o.max_attempts
    order by o.created_at
    limit p_limit
    for update skip locked
  )
  update wa_outbox o
  set status = 'sending', attempts = attempts + 1
  from batch b
  where o.id = b.id
  returning o.id, o.phone, o.body, o.template_name, o.template_params;
end;
$function$;

-- notify-tracking-status (edge): mismo chequeo al principio del handler, después del guard del
-- secreto — ver supabase/functions/notify-tracking-status (se versiona en este repo con este cambio).

-- Chequeo:
--   select value from public.app_settings where key = 'wa_envio_automatico';   -- '0'
--   select count(*) from public.bot_flush_outbox(20);                          -- 0 con la llave en '0'
-- Rollback (definición VIVA antes de 068, tomada con pg_get_functiondef el 25/09):
--   CREATE OR REPLACE FUNCTION public.bot_flush_outbox(p_limit integer DEFAULT 20)
--    RETURNS TABLE(id bigint, phone text, body text, template_name text, template_params jsonb)
--    LANGUAGE plpgsql SECURITY DEFINER
--   AS $function$
--   BEGIN
--     RETURN QUERY
--     WITH batch AS (SELECT o.id FROM wa_outbox o WHERE o.status = 'pending'
--         AND o.attempts < o.max_attempts ORDER BY o.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
--     UPDATE wa_outbox o SET status = 'sending', attempts = attempts + 1 FROM batch b
--     WHERE o.id = b.id RETURNING o.id, o.phone, o.body, o.template_name, o.template_params;
--   END; $function$;
--   delete from public.app_settings where key = 'wa_envio_automatico';
