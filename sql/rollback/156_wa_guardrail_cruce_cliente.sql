-- Rollback de sql/156: devuelve bot_flush_outbox a la definición anterior (sin el guardrail) y borra las funciones nuevas.
-- Las filas que el guardrail dejó en held_no_whitelist con error 'cruce_cliente…' NO se reenvían solas: revisarlas a mano.

create or replace function public.bot_flush_outbox(p_limit integer default 20)
 returns table(id bigint, phone text, body text, template_name text, template_params jsonb)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_modo text := coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0');
begin
  if v_modo not in ('prueba', '1') then
    return;
  end if;

  update wa_outbox o
     set status = 'held_no_whitelist'
   where o.status = 'pending'
     and not wa_puede_enviar(o.phone);

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

drop function if exists public.wa_puede_enviar_a(text, text, text);
drop function if exists public.wa_destino_cruzado(text, text, text, uuid);
drop function if exists public.wa_telefono_de_prueba(text);
drop function if exists public.wa_claves_del_telefono(text);
drop function if exists public.wa_claves_de_cliente(uuid, text, text);
