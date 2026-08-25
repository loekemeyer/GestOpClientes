-- Triggers para notificaciones proactivas al cambiar tracking
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

create or replace function trg_order_tracking_notify()
returns trigger as $$
declare
  v_phone text;
  v_customer_id bigint;
  v_body text;
begin
  -- Buscar cliente y teléfono del pedido
  select o.customer_id, cp.phone
  into v_customer_id, v_phone
  from orders o
  join customer_phones cp on cp.customer_id = o.customer_id and cp.opt_out = false
  where o.id::text = new.np_number
  limit 1;

  -- Si no tiene teléfono vinculado, salir
  if v_phone is null then return new; end if;

  -- Encolar notificación según estado
  if new.status = 'programado' and new.fecha_entrega is not null then
    insert into wa_outbox (phone, template_name, template_params, customer_id)
    values (v_phone, 'pedido_programado',
            jsonb_build_object('order_id', new.np_number, 'fecha', to_char(new.fecha_entrega, 'DD/MM/YYYY')),
            v_customer_id);

  elsif new.status = 'entregado' then
    insert into wa_outbox (phone, template_name, template_params, customer_id)
    values (v_phone, 'pedido_entregado',
            jsonb_build_object('order_id', new.np_number),
            v_customer_id);
  end if;

  return new;
end;
$$ language plpgsql security definer;

-- En INSERT y UPDATE de order_tracking
create trigger order_tracking_wa_notify
  after insert or update of status on order_tracking
  for each row execute function trg_order_tracking_notify();
