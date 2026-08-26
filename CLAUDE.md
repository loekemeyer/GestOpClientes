# BotWA-LK — Instrucciones para Claude Code

## Qué es este proyecto

Bot WhatsApp para clientes mayoristas de Loekemeyer. Corre como Supabase Edge Function
en el proyecto PaginaLK (`kwkclwhmoygunqmlegrg`).

## Proyectos hermanos (NO modificar desde acá)

- **PaginaLK** (`\\loeke-svr\...\Pagina WEB\Pagina Actual\PaginaLK-main\`) — tablas orders, products, customers. RPCs: `submit_order_fast`, `edit_order_fast`.
- **Virgilio** (`\\loeke-svr\...\_pv_fresh\`) — tablas whatsapp_clientes, whatsapp_vendedores. Patrón telegram_outbox reutilizado para wa_outbox.
- **Planify** (`\\loeke-svr\...\Planify 3.5\Planify-Gest-Prod\supafn\supabase\functions\planify_whatsapp-webhook\index.ts`) — webhook WhatsApp de referencia. Copiar patrones de `waPost`, `sendText`, `canonPhone`, `phoneVariants`.

## Convenciones

- Edge Functions en TypeScript (Deno runtime)
- SQL migrations numeradas: `NNN_descripcion.sql`
- Secrets via `Deno.env.get()` (supabase secrets set KEY=VALUE)
- Claude API: llamadas HTTP directas (sin SDK), tool-use para conversación
- WhatsApp API: Meta Cloud API v21.0 via `graph.facebook.com`
- Teléfonos: las RPCs `bot_*` normalizan con regex, no hace falta normalizar en el código
- Estado conversacional en tablas Supabase (no en memoria)
- Historial de chat via `bot_guardar_mensaje` / `bot_leer_historial`
- Respuestas WA max 4000 chars

## Modelos Claude

| Uso | Modelo | Razón |
|-----|--------|-------|
| Conversacional con tool-use | `claude-sonnet-4-6` | Balance costo/calidad, bueno con tools |
| Scoring / análisis | `claude-sonnet-4-6` | Necesita razonamiento |

## Infraestructura existente (RPCs bot_*)

Todo el acceso a datos va por RPCs `security definer`, no por queries directos.

### Lookup / Registro
- `bot_cliente_por_whatsapp(p_telefono)` → (customer_id, cod_cliente, business_name, dto_vol)
- `bot_register_request_v2(p_telefono, p_cuit)` → flujo de registro (auto_associated / pending_primary / cuit_not_found)
- `bot_register_decide(p_request_id, p_decision, p_agente, p_motivo)` → aprobación por asesor
- `bot_register_decide_by_primary(p_request_id, p_decision)` → aprobación por titular

### Consulta de datos (usadas como tools de Claude)
- `bot_mis_pedidos(p_telefono, p_limit)` → pedidos recientes
- `bot_detalle_pedido(p_telefono, p_order_id)` → detalle con verificación de propiedad
- `bot_detalle_por_indice(p_telefono, p_indice)` → detalle por posición (1 = más reciente)
- `bot_mi_entrega(p_telefono)` → tracking/entregas
- `bot_mis_descuentos(p_telefono)` → descuentos del cliente
- `bot_buscar_productos(p_query, p_limit)` → búsqueda con sinónimos
- `bot_mis_top_productos(p_telefono, p_limit)` → productos más comprados
- `bot_productos_novedades(p_limit)` → nuevos y liquidación
- `bot_obtener_catalogo_url()` → URL del catálogo PDF
- `bot_obtener_imagenes_producto(p_cod)` → URLs de imágenes
- `bot_kb_consultar(p_query, p_limit)` → base de conocimiento

### Historial y modo
- `bot_guardar_mensaje(p_telefono, p_rol, p_contenido)` → guardar en historial
- `bot_leer_historial(p_telefono, p_limit)` → leer historial (más reciente primero)
- `bot_conv_get_modo(p_telefono)` → modo actual ('bot' o 'humano')
- `bot_conv_set_modo(p_telefono, p_modo, p_agente, p_motivo, p_horas)` → cambiar modo
- `bot_auditar_tool(p_telefono, p_tool, p_params, p_resumen)` → auditoría de tools

### Tablas clave
- `bot_customer_whatsapps` — vinculación teléfono-cliente (PK lookup para el bot)
- `bot_historial_chat` — historial de conversaciones (rol: user/assistant)
- `bot_conversaciones` — modo bot/humano por teléfono
- `bot_auditoria` — log de tools usadas
- `bot_knowledge_base` — preguntas y respuestas del negocio
- `bot_registration_requests` — solicitudes de registro pendientes

### Tablas de producto
- `products` — catálogo de productos activos (cod, description, list_price, uxb, category, images[])
- `loke_products` — productos marca propia (misma estructura + equiv_product_id)
- `bot_sinonimos` — sinónimos para búsqueda (termino → sinonimos text[])

### Pedidos
- `orders` — pedidos (customer_id, status, total, payment_method, descuentos)
- `order_items` — líneas (product_id, loke_product_id, cajas, uxb, is_loke, source)
- `order_tracking` — tracking (np_number, status, fecha_entrega, cod_cliente)
- `submit_order_fast(...)` — RPC web (requiere auth.uid())
- `bot_submit_order(...)` — RPC bot (por teléfono, sin auth, sql/007)

### Notificaciones (patrón outbox — sql/008)
- `wa_outbox` — cola de mensajes salientes (pending → sending → sent/failed, con reintentos)
- `trg_notify_order_created` — trigger en orders INSERT → inserta en wa_outbox (pedido recibido)
- `trg_order_tracking_notify` — trigger en order_tracking INSERT/UPDATE → inserta en wa_outbox (programado/entregado)
- `bot_flush_outbox(p_limit)` — RPC: toma batch pendiente con FOR UPDATE SKIP LOCKED
- `bot_outbox_mark(p_id, p_status, p_error)` — RPC: marca resultado de envío (con retry automático)
- `pg_cron wa_outbox_flush` — cada 2 min → POST action:flush a lk_whatsapp-webhook

## Flujo principal

1. Meta envía POST al webhook
2. Chequear `bot_conv_get_modo` → si 'humano', guardar y no responder
3. `bot_cliente_por_whatsapp(phone)` → buscar cliente
4. Si no encontrado: flujo de registro (`bot_register_request_v2`)
5. Si encontrado: cargar historial, ejecutar Claude con tool-use
6. Claude decide qué tools llamar (pedidos, productos, entregas, etc.)
7. Ejecutar tools via RPCs, devolver resultados a Claude
8. Enviar respuesta + media (fotos, catálogo) vía Meta API
9. Guardar mensajes en historial

## Testing

- `supabase functions serve lk_whatsapp-webhook --env-file .env.local`
- Usar ngrok para exponer localhost a Meta webhook
- Meta test numbers para desarrollo

## Reglas

- NUNCA modificar bases de datos, tablas, funciones, policies ni cualquier otro recurso de proyectos hermanos (Virgilio, PaginaLK, Costos, Planify) sin avisar explícitamente al usuario que el cambio es en OTRO proyecto y obtener confirmación. Documentar cualquier cambio cross-project necesario en el SQL migration correspondiente de este repo como comentario, para que el usuario lo aplique manualmente.
- NUNCA hardcodear anon key ni service role key en el código fuente
- NUNCA enviar datos sensibles del cliente a Claude (solo lo necesario)
- Siempre responder 200 a Meta (incluso en error interno) para no perder webhook
- Rate limit: max 80 msg/seg por número (Meta), respetar 24h window para templates
