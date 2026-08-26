# BotWA-LK — Instrucciones para Claude Code

## Configuraciones y comandos especiales

**Estado central:** `config-claude.json` — toggles y comandos que afectan CUALQUIER chat.

### Modos

- **caveman (SIEMPRE activo por defecto)**: Responder en modo caveman — frases cortas, directas, mínimas palabras, sin artículos, sin fluff. Solo aplica al **chat** (no al código, comentarios ni mensajes de commit). **"desactiva caveman"** = responder solo el **próximo mensaje** normal/completo, y después **volver solo** a caveman. **"caveman desactivacion total"** = apagar caveman por completo (queda desactivado hasta que se reactive).
  - Activar: "activa caveman" → ejecuta `./scripts/caveman-toggle.sh on`
  - Desactivar: "desactiva caveman" → ejecuta `./scripts/caveman-toggle.sh off`
  - Estado guardado en `caveman-state.json` y `config-claude.json`
- **tablas_compactas**: Tablas con separación mínima, headers en doble fila si hace falta, nombres abreviados, optimiza anchura. Siempre activo.

### Comandos especiales

- **resumen del día**: Reporte del trabajo de hoy en bullet points. Estilo ejecutivo. Incluye: completadas, en progreso, bloqueados, próximos pasos.

---

# CAVEMAN MODE
Respond like caveman. No articles, no filler words, no pleasantries.
Short. Direct. Code speaks for itself.
If asked for code, give code. No explain unless asked.
No sycophancy. No restating question. No sign-offs.
State: caveman-state.json (true/false). Say "activa caveman" or "desactiva caveman" to toggle.

---

## Qué es este proyecto

Bot WhatsApp para clientes mayoristas de Loekemeyer. Corre como Supabase Edge Function
en el proyecto PaginaLK (`kwkclwhmoygunqmlegrg`).

## Proyectos hermanos (NO modificar desde acá)

- **PaginaLK** (repo privado separado) — tablas orders, products, customers. RPCs: `submit_order_fast`, `edit_order_fast`.
- **Virgilio** (repo privado separado) — tablas whatsapp_clientes, whatsapp_vendedores. Patrón telegram_outbox reutilizado para wa_outbox.
- **Planify** (repo privado separado, referencia en `planify_whatsapp-webhook/index.ts`) — webhook WhatsApp de referencia. Copiar patrones de `waPost`, `sendText`, `canonPhone`, `phoneVariants`.

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

## Tablas nuevas (en schema public de PaginaLK)

- `customer_phones` — vincula teléfono WA con customer
- `wa_outbox` — cola de mensajes salientes (patrón Virgilio)
- `wa_order_draft` — borrador de pedido en curso por WA
- `wa_conversations` — log de mensajes (in/out) para auditoría

## Flujo principal

1. Meta envía POST al webhook
2. Buscar teléfono en `customer_phones`
3. Si no existe: flujo de vinculación (pedir CUIT/código)
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
