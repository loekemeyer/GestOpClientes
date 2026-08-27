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
| Intent detection / parsing | `claude-haiku-4-5-20251001` | Rápido, barato, suficiente para clasificar |
| Conversacional / respuestas complejas | `claude-sonnet-4-6` | Balance costo/calidad |
| Scoring / análisis | `claude-sonnet-4-6` | Necesita razonamiento |

## Tablas nuevas (en schema public de PaginaLK)

- `customer_phones` — vincula teléfono WA con customer
- `wa_outbox` — cola de mensajes salientes (patrón Virgilio)
- `wa_order_draft` — borrador de pedido en curso por WA
- `wa_conversations` — log de mensajes (in/out) para auditoría
- `bot_token_usage` — log de tokens/costo por llamada a Claude API
- `wa_faq` — preguntas frecuentes catalogadas con respuestas y nivel de automatización
- `product_aliases` — aliases de productos para matching por texto libre (pg_trgm)

### Funciones SQL del bot
- `wa_product_match(query, limit)` — búsqueda inteligente de productos (aliases → trigrama → ILIKE)
- `wa_identify_customer(phone)` — Paso 0: identifica cliente por teléfono normalizando variantes

## Flujo principal

1. Meta envía POST al webhook
2. Buscar teléfono en `customer_phones`
3. Si no existe: flujo de vinculación (pedir CUIT/código)
4. Si existe: detectar intent con Claude haiku
5. Ejecutar acción (consulta pedido / nuevo pedido / conversacional)
6. Responder vía Meta API

## Categorización de preguntas (Clasificación interna)

Toda pregunta de cliente entra en UNA de estas 4 categorías. Aplica tanto a FAQs catalogadas como a nuevas preguntas:

| Categoría | Definición | Ejemplo | Implementación |
|-----------|-----------|---------|-----------------|
| **AUTO** | Respuesta estática, copy-paste sin cambios | "¿Cuáles son los horarios?" → "L-V 9-18, Sábado 10-14" | Plantilla en `wa_faq.bot_response` |
| **SEMIAUTO** | Plantilla + datos de Supabase (lookup sin IA) | "¿Cuándo llega mi pedido?" → Buscar en `order_tracking` y completar fecha | `handleFaqLookup` con RPC (`order_status`, `customer_discount`, `product_price`, etc.) |
| **INTELIGENCIA** | Requiere Claude (parsing, clasificación, matching) | "3 cajas de abrelatas rojos" → IA identifica producto, puede haber múltiples; preguntar cuál | Intent detection (`detectIntent`) + `handleNewOrder`, `handleGeneral` |
| **HUMANO** | Requiere aprobación/revisión de un vendedor | Aprobación de cliente nuevo después de toma de datos → enviar a vendedor | Escalación automática (`automation_level: "needs_human"`) o bandera `status: "pending"` en `wa_prospect_leads` |

**Regla de oro**: Minimizar IA (SEMIAUTO > AUTO > INTELIGENCIA > HUMANO) → solo gastar tokens cuando no hay otra opción.

## Mapa de implementación

### Edge Functions

| Función | Archivo | Qué hace |
|---------|---------|----------|
| `lk_whatsapp-webhook` | `supabase/functions/lk_whatsapp-webhook/index.ts` | Webhook producción Meta. Recibe POST, identifica cliente, detecta intent, responde vía WA API. Usa `matchFAQ` (viejo, keywords en `claude.ts`) |
| `lk_chat-test` | `supabase/functions/lk_chat-test/index.ts` | Endpoint de test (dashboard). Misma lógica pero sin enviar a WA. Usa `wa_faq_match` RPC (nuevo, trigram). También expone: stats, config rate limit, blacklist CRUD |

### Shared modules (`supabase/functions/_shared/`)

| Archivo | Exports principales |
|---------|-------------------|
| `wa-api.ts` | `canonPhone`, `waPost`, `sendText`, `sendTemplate`, `markRead`, `parseIncoming` |
| `claude.ts` | `claudeMessage`, `detectIntent` (Haiku), `conversationalReply` (Sonnet), `matchFAQ` (keywords legacy) |
| `supabase.ts` | `supabase` (client PaginaLK), `getSetting`, `getIsisClient` (client ISIS para facturas) |

### Handlers en `lk_chat-test/index.ts`

| Handler | Intent / trigger | Categoría | Qué hace |
|---------|-----------------|-----------|----------|
| `handleFaq` | Pre-intent (trigram match) | AUTO/SEMIAUTO | Busca en `wa_faq` vía RPC `wa_faq_match`. Si score ≥ 0.3 responde sin gastar tokens |
| `handleFaqLookup` | FAQ con `requires_db_lookup` | SEMIAUTO | Lookup real: `order_status`, `customer_discount`, `product_price`, `product_stock`, `order_modify` |
| `handleLinking` | Cliente no identificado | — | Pide CUIT/código, busca en `customers`. Si "soy nuevo" → crea lead en `wa_prospect_leads` |
| `handleAltaStep` | Lead en curso | HUMANO | Alta paso a paso (13 campos + pregunta extra). Status final: `complete` → vendedor revisa |
| `handleOrderQuery` | `consulta_pedido` | SEMIAUTO | Últimos 5 pedidos (90 días) + tracking |
| `handleNewOrder` | `nuevo_pedido` | INTELIGENCIA | Parsea productos con Sonnet → `wa_product_match` → draft en `wa_order_draft` → confirmar → `bot_submit_order` |
| `handlePickup` | `retiro` | SEMIAUTO | Busca pedidos programados en `order_tracking` |
| `handleCancel` | `cancelar` | SEMIAUTO | Cancela borrador en `wa_order_draft` (status → expired) |
| `handleInvoiceQuery` | `consulta_factura` | INTELIGENCIA | Parsea con Haiku → busca en ISIS vía RPC `buscar_factura` → formatea resultados |
| `handleGeneral` | `otro` / fallback | INTELIGENCIA | Respuesta conversacional con Sonnet |
| `handleStats` | `action: "stats"` | Admin | Costo tokens mes/semana/sesión desde `bot_token_usage` |
| `handleConfigGet/Save` | `action: "config_*"` | Admin | Lee/guarda rate limit en `app_settings` |
| `handleBlacklist*` | `action: "blacklist_*"` | Admin | CRUD `wa_blacklist` |

### Funciones SQL (RPCs)

| RPC | Archivo SQL | Qué hace |
|-----|-------------|----------|
| `wa_identify_customer` | `sql/010_*` | Identifica cliente por teléfono (normaliza variantes) |
| `wa_product_match` | `sql/008_*` | Búsqueda inteligente: aliases → trigrama → ILIKE |
| `wa_faq_match` | `sql/007_*` + actualizaciones | Matchea texto contra FAQs por trigram similarity |
| `wa_check_rate_limit` | `sql/012_*` | Rate limit por teléfono (msgs/hora) |
| `bot_submit_order` | PaginaLK (externo) | Crea pedido desde borrador WA |
| `buscar_factura` | ISIS (externo) | Busca comprobantes en sistema de facturación |

### Tablas propias del bot

| Tabla | Archivo SQL | Propósito |
|-------|-------------|-----------|
| `customer_phones` | `sql/001_*` | Vincula teléfono WA ↔ customer (legacy, reemplazada por `bot_customer_whatsapps`) |
| `bot_customer_whatsapps` | — | Vinculación teléfono ↔ customer (actual) |
| `wa_outbox` | `sql/002_*` | Cola de mensajes salientes (patrón Virgilio) |
| `wa_order_draft` | `sql/003_*` | Borrador de pedido en curso (status: building → confirming → submitted/expired) |
| `wa_conversations` | `sql/004_*` | Log de mensajes in/out para auditoría |
| `bot_token_usage` | — | Log de tokens/costo por llamada Claude API |
| `wa_faq` | `sql/007_*` + 009-031 | FAQs con categoría, automation_level, bot_response, triggers |
| `product_aliases` | `sql/008_*` | Aliases de productos para matching (pg_trgm) |
| `wa_blacklist` | `sql/012_*` | Teléfonos bloqueados |
| `wa_prospect_leads` | `sql/013_*` | Leads de clientes nuevos (alta paso a paso) |
| `app_settings` | — | Config key/value (rate limits, API keys, ISIS credentials) |

### Conexiones externas

| Sistema | Cómo conecta | Para qué |
|---------|-------------|----------|
| **Meta WA API** | `graph.facebook.com/v21.0` vía `wa-api.ts` | Enviar/recibir mensajes, templates, mark read |
| **Claude API** | `api.anthropic.com/v1/messages` vía `claude.ts` | Intent detection (Haiku), parsing (Haiku), respuestas (Sonnet) |
| **ISIS Supabase** | Client separado vía `getIsisClient()` | Búsqueda de facturas/comprobantes (`buscar_factura`) |
| **PaginaLK Supabase** | Client principal (`supabase`) | Todo lo demás (clientes, pedidos, FAQs, config) |

### Templates WhatsApp (pendiente creación en Meta)

| Nombre | Variables | Uso previsto |
|--------|-----------|-------------|
| `pedido_facturado_sale` | fecha, nro_pedido, total_iva, importe_contado | Notificar despacho + datos de pago |
| `pedido_facturado_echeq` | fecha, nro_pedido, total_iva, importe_contado, dias_echeq | Despacho con pago e-cheq |
| `pedido_recordatorio_25` | nro_pedido, importe_contado, fecha_vencimiento | Recordatorio descuento 25% contado |

## Testing

- `supabase functions serve lk_whatsapp-webhook --env-file .env.local`
- Usar ngrok para exponer localhost a Meta webhook
- Meta test numbers para desarrollo

## Reglas

- NUNCA hardcodear anon key ni service role key en el código fuente
- NUNCA enviar datos sensibles del cliente a Claude (solo lo necesario)
- Siempre responder 200 a Meta (incluso en error interno) para no perder webhook
- Rate limit: max 80 msg/seg por número (Meta), respetar 24h window para templates
- Bumpear versión en badge de `docs/index.html` con cada cambio al front

## Versionado (dashboard)

Formato `vX.Y.Z`:
- **X** = full release (0 mientras esté en beta)
- **Y** = big feature, módulo nuevo funcional, landmark importante
- **Z** = bump por cambios menores (la más común)

**SIEMPRE comunicar versión al usuario**: Al implementar cambios, decirle al usuario qué versión debería ver en la página. Si el cambio toca el front → bumpear badge y decir la nueva versión. Si es solo backend → aclarar que la versión visible no cambia y cuál es la actual.

## Coordinación multi-sesión

Varias sesiones Claude trabajan en paralelo sobre este repo. Para no romperse entre sí:

### Regla de oro
**Siempre basar tu branch en `origin/main` actualizado.** Antes de crear una branch o empezar a trabajar:
```bash
git fetch origin main
git checkout -B mi-branch origin/main
```

### Zonas de responsabilidad

| Zona | Archivos | Quién modifica |
|------|----------|----------------|
| **Backend SQL** | `sql/*.sql` | Cualquier sesión (numerar secuencialmente, verificar último número en main) |
| **Edge Functions** | `supabase/functions/**` | Solo sesiones que trabajan en lógica del bot |
| **Frontend** | `docs/index.html` | Solo sesiones que trabajan en el dashboard |
| **Config proyecto** | `CLAUDE.md`, `.claude/`, `config-claude.json` | Con cuidado — leer antes de escribir |

### Qué NO hacer
- **NO mergear una branch vieja** que borra archivos que no tocaste — verificar con `git diff --stat origin/main..mi-branch` antes de mergear
- **NO borrar archivos que no creaste** — si tu diff muestra deleciones de archivos que no modificaste, tu branch está desactualizada
- **NO pushear directo a main** sin verificar que no hay conflictos con lo que otros pushearon

### Cómo agregar archivos nuevos sin riesgo
Si tu sesión solo agrega archivos nuevos (ej: migraciones SQL), usar cherry-pick de archivos:
```bash
git checkout origin/mi-branch -- sql/007_nuevo.sql sql/008_otro.sql
```
Esto trae solo esos archivos sin tocar el resto.

### Migraciones SQL
- Verificar el último número en `sql/` de `origin/main` antes de numerar
- Si dos sesiones crean la misma numeración, la segunda renumera
- Cada migración debe ser idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- **APLICAR a Supabase al crear**: Cuando crees una migración SQL, aplicarla inmediatamente al proyecto Supabase PaginaLK (`kwkclwhmoygunqmlegrg`) usando `mcp__Supabase__apply_migration`. No dejar migraciones sin aplicar.

### Checklist pre-merge
1. `git fetch origin main`
2. `git diff --stat origin/main..HEAD` — ¿hay deleciones inesperadas?
3. Si hay deleciones de archivos que no tocaste → tu branch está rota, NO mergear
4. Si solo hay adiciones y modificaciones de archivos que sí tocaste → OK
