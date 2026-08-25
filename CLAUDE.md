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
- Secrets en tabla `app_settings` (key/value), NO en .env
- Claude API: llamadas HTTP directas (sin SDK), mismo patrón que Planify
- WhatsApp API: Meta Cloud API v21.0 via `graph.facebook.com`
- Teléfonos siempre en formato canónico (sin +, sin 54 9, solo número local)
- Estado conversacional en tablas Supabase (no en memoria)
- Respuestas WA max 4000 chars

## Modelos Claude

| Uso | Modelo | Razón |
|-----|--------|-------|
| Intent detection / parsing | `claude-haiku-4-5` | Rápido, barato, suficiente para clasificar |
| Conversacional / respuestas complejas | `claude-sonnet-4-6` | Balance costo/calidad |
| Scoring / análisis | `claude-sonnet-4-6` | Necesita razonamiento |

## Tablas existentes usadas (en schema public de PaginaLK)

- `customers` — columna `whatsapp` para identificación por teléfono, `wa_opt_out` para opt-out
- `orders` + `order_items` — pedidos y líneas
- `order_tracking` — seguimiento (programado/recibido/entregado)
- `products` — catálogo de productos activos
- `app_settings` — secrets (key/value)

## Tablas nuevas (en schema public de PaginaLK)

- `wa_outbox` — cola de mensajes salientes (patrón Virgilio)
- `wa_order_draft` — borrador de pedido en curso por WA
- `wa_conversations` — log de mensajes (in/out) para auditoría

## Flujo principal

1. Meta envía POST al webhook
2. Buscar teléfono en `customers.whatsapp` (con phoneVariants para normalizar)
3. Si no existe: flujo de vinculación (pedir CUIT/código → linkear whatsapp)
4. Si existe: detectar intent con Claude haiku
5. Ejecutar acción (consulta pedido / nuevo pedido / conversacional)
6. Responder vía Meta API

## Testing

- `supabase functions serve lk_whatsapp-webhook --env-file .env.local`
- Usar ngrok para exponer localhost a Meta webhook
- Meta test numbers para desarrollo

## Reglas

- NUNCA hardcodear anon key ni service role key en el código fuente
- NUNCA enviar datos sensibles del cliente a Claude (solo lo necesario)
- Siempre responder 200 a Meta (incluso en error interno) para no perder webhook
- Rate limit: max 80 msg/seg por número (Meta), respetar 24h window para templates
