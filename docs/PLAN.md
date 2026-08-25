# Plan de desarrollo — BotWA-LK

## Paso 1 — Infraestructura base (3-4 días)

### 1.1 Edge Function webhook
- Crear `supabase/functions/lk_whatsapp-webhook/index.ts`
- Copiar y adaptar de Planify: `waPost`, `sendText`, `sendTemplate`, `downloadMedia`, `canonPhone`, `phoneVariants`
- GET: verificación Meta (hub.mode=subscribe)
- POST: router de mensajes entrantes
- Siempre retornar 200

### 1.2 Shared modules
- `_shared/wa-api.ts` — todas las funciones Meta API
- `_shared/claude.ts` — wrapper Claude API HTTP directo
- `_shared/supabase.ts` — cliente con service_role key

### 1.3 Config WhatsApp Business
- Crear app en Meta Developer Portal (o agregar número al existente)
- Configurar webhook URL apuntando a la Edge Function
- Suscribir a eventos: messages, message_status
- Guardar secrets en `app_settings`

### 1.4 Tabla customer_phones
- Migración `001_customer_phones.sql`
- Precarga de teléfonos desde `whatsapp_clientes` (Virgilio) si están disponibles

## Paso 2 — Identificación de clientes (incluido en paso 1)

### Flujo vinculación
1. Mensaje de número desconocido
2. Bot: "Hola, soy el asistente de Loekemeyer. ¿Cuál es tu código de cliente o CUIT?"
3. Cliente responde
4. Match contra `customers.cod_cliente` o `customers.cuit`
5. Si match: insertar en `customer_phones`, saludar por nombre
6. Si no match: "No encontré ese código. Verificá e intentá de nuevo, o contactanos a ventas@loekemeyer.com"

## Paso 3 — Consulta estado de pedido (3-4 días)

### Intent detection
- Claude haiku con system prompt corto
- Input: mensaje del cliente
- Output: JSON `{ intent: "consulta_pedido" | "nuevo_pedido" | "retiro" | "otro", details: string }`

### Query
```sql
select o.id, o.created_at, o.total, o.status,
       t.status as tracking_status, t.fecha_entrega
from orders o
left join order_tracking t on t.np_number = o.id::text
where o.customer_id = $1
  and o.created_at > now() - interval '90 days'
order by o.created_at desc
limit 5;
```

### Respuesta
- 0 pedidos: "No tenés pedidos recientes."
- 1 pedido: estado directo
- N pedidos: lista numerada, opción de detalle

## Paso 4 — Notificaciones proactivas (2-3 días)

### Tabla wa_outbox
- Migración `002_wa_outbox.sql`
- Campos: phone, body, template_name, template_params, status, timestamps

### Triggers
- `order_tracking` INSERT/UPDATE → encolar aviso
- Requiere templates aprobados por Meta:
  - `pedido_programado` — "Tu pedido #{id} fue programado para el {fecha}."
  - `pedido_entregado` — "Tu pedido #{id} fue entregado."

### Flush
- pg_cron cada 2 min
- Lee pending, envía, marca sent/failed
- Retry con backoff (3 intentos)

## Paso 5 — Recepción de pedidos por WA (5-7 días)

### Tabla wa_order_draft
- Migración `003_wa_order_draft.sql`
- Campos: phone, customer_id, items (jsonb), status, created_at, updated_at
- TTL: 30 min sin actividad → expirar

### Flujo
1. "Quiero hacer un pedido"
2. Bot: "Dale, decime qué necesitás (producto y cantidad en cajas)"
3. Claude parsea: `{ product_query: "cuchillo asado", cajas: 12 }`
4. Fuzzy match contra `products` (por código o descripción)
5. Si ambiguo: "Encontré varios: 1) Cuchillo Asado 22cm 2) Cuchillo Asado 25cm. ¿Cuál?"
6. Confirma item, pregunta "¿Algo más?"
7. "Listo" → resumen con subtotal/descuentos/total
8. "Confirmar" → `submit_order_fast` RPC
9. Push a Sheets, generar PDF

### Búsqueda de productos
```sql
select id, cod, description, list_price, uxb
from products
where active = true
  and (description ilike '%' || $1 || '%' or cod ilike '%' || $1 || '%')
limit 5;
```

## Paso 6 — Reactivación de clientes inactivos (3-4 días)

### Vista
```sql
create view v_clientes_inactivos as
select c.id, c.business_name, c.cod_cliente, cp.phone,
       max(o.created_at) as ultimo_pedido,
       now() - max(o.created_at) as dias_sin_compra
from customers c
join customer_phones cp on cp.customer_id = c.id
join orders o on o.customer_id = c.id
group by c.id, c.business_name, c.cod_cliente, cp.phone
having max(o.created_at) < now() - interval '90 days';
```

### Cron semanal (lunes 10:00 AR)
- Consulta `v_clientes_inactivos`
- Encola template message a `wa_outbox`
- Template Meta: `reactivacion_cliente` — personalizado con nombre y días

### Controles
- No enviar más de 1 vez por mes al mismo cliente
- Tabla `wa_reactivation_log` para tracking
- Opt-out: cliente responde "no quiero recibir más mensajes" → flag en customer_phones
