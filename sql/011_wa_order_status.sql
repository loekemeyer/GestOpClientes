-- ============================================================
-- 011_wa_order_status.sql
-- Función para consultar estado de pedidos de un cliente
-- ============================================================
-- Usada por el bot en la pregunta #9 (Confirmar fecha de retiro)
-- y #4 (Estado del pedido / ¿Cuándo llega?).
--
-- Recibe cod_cliente y retorna sus pedidos activos (recibido, programado)
-- más los últimos entregados recientes (últimos 30 días).
--
-- El bot usa esta info para responder:
--   - "recibido" → pedido recibido, en preparación, sin fecha aún
--   - "programado" → pedido programado (fecha_entrega puede ser NULL)
--   - "entregado" → ya entregado en fecha X
--   - sin pedidos → no hay pedidos activos
-- ============================================================

create or replace function wa_customer_orders(p_cod_cliente text)
returns table (
  np_number       text,
  status          text,
  fecha_entrega   date,
  updated_at      timestamptz,
  days_since      integer
)
language sql
stable
as $$
  select
    ot.np_number,
    ot.status,
    ot.fecha_entrega,
    ot.updated_at,
    (current_date - ot.updated_at::date) as days_since
  from order_tracking ot
  where ot.cod_cliente = p_cod_cliente::integer
    and (
      -- Pedidos activos (siempre)
      ot.status in ('recibido', 'programado')
      -- Entregados recientes (últimos 30 días)
      or (ot.status = 'entregado' and ot.fecha_entrega >= current_date - 30)
    )
  order by
    case ot.status
      when 'programado' then 1
      when 'recibido'   then 2
      when 'entregado'  then 3
    end,
    ot.updated_at desc;
$$;

comment on function wa_customer_orders is
  'Retorna pedidos activos y entregados recientes de un cliente.
   Usado por el bot para preguntas #4 (estado pedido) y #9 (fecha retiro).
   Ordenados por prioridad: programado > recibido > entregado.';
