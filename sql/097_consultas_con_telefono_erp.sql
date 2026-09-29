-- 097 — (APLICADA 29/09 a PaginaLK) Las consultas del bot reconocen al cliente también por el teléfono del ERP.
-- Estudio de cobertura (causa C) y simulador (29/09): un cliente que el webhook reconoce por wa_clientes_telefono /
-- customers.whatsapp (no agendado) recibía "no encontré pedidos", porque bot_cliente_por_whatsapp sólo miraba
-- bot_customer_whatsapps. Ahora, si no hay vínculo agendado, usa wa_identify_customer (el mismo reconocimiento del
-- webhook, que ya descarta teléfonos ambiguos entre empresas). bot_mi_entrega pasa a usar esta misma función.
-- Afecta a todas las consultas que dependen de ella: pedidos, detalle, descuentos, más comprados, facturas, entregas.
create table if not exists zz_backups.bkp_cliente_por_whatsapp_20260929 as
  select p.proname, pg_get_functiondef(p.oid) as definicion, now() as guardado_en
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('bot_cliente_por_whatsapp', 'bot_mi_entrega');
alter table zz_backups.bkp_cliente_por_whatsapp_20260929 enable row level security;

create or replace function public.bot_cliente_por_whatsapp(p_telefono text)
 returns table(customer_id uuid, cod_cliente bigint, business_name text, dto_vol numeric)
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  return query
  select c.id, c.cod_cliente, c.business_name, coalesce(c.dto_vol, 0)
  from public.bot_customer_whatsapps cw
  join public.customers c on c.id = cw.customer_id
  where regexp_replace(coalesce(cw.whatsapp,''), '[^0-9]', '', 'g') = regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g')
    and regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g') <> ''
  order by cw.is_primary desc, cw.created_at desc
  limit 1;
  if found then return; end if;

  -- sql/097: sin vínculo agendado → el mismo reconocimiento por teléfono del ERP que usa el webhook.
  return query
  select c.id, c.cod_cliente, c.business_name, coalesce(c.dto_vol, 0)
  from public.wa_identify_customer(p_telefono) w
  join public.customers c on c.id = w.customer_id
  limit 1;
end $function$;

do $$
declare d text; viejo text;
begin
  d := pg_get_functiondef('public.bot_mi_entrega(text)'::regprocedure);
  viejo := $x$  select cw.cod_cliente, cw.customer_id into v_cod, v_cid
    from public.bot_customer_whatsapps cw
   where regexp_replace(coalesce(cw.whatsapp,''), '[^0-9]', '', 'g')
       = regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g')
     and regexp_replace(coalesce(p_telefono,''), '[^0-9]', '', 'g') <> ''
   order by cw.is_primary desc, cw.created_at desc
   limit 1;$x$;
  if position(viejo in d) = 0 then raise exception 'bot_mi_entrega: no encontré la búsqueda por teléfono'; end if;
  execute replace(d, viejo, $x$  select cc.cod_cliente, cc.customer_id into v_cod, v_cid
    from public.bot_cliente_por_whatsapp(p_telefono) cc;  -- sql/097: agendado o teléfono del ERP$x$);
end $$;
