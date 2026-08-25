# BotWA-LK — Bot WhatsApp Clientes Loekemeyer

Bot conversacional WhatsApp para gestión de clientes mayoristas de Loekemeyer Hnos S.R.L.

## Qué hace

| Feature                      | Estado     |
|------------------------------|------------|
| Identificación de cliente    | ✅ hecho   |
| Consulta estado de pedido    | ✅ hecho   |
| Consulta entregas/tracking   | ✅ hecho   |
| Búsqueda de productos        | ✅ hecho   |
| Descuentos del cliente       | ✅ hecho   |
| Envío catálogo/fotos         | ✅ hecho   |
| Base de conocimiento         | ✅ hecho   |
| IA conversacional (tool-use) | ✅ hecho   |
| Modo humano (pausa bot)      | ✅ hecho   |
| Carga de pedidos por WA      | 🔲 pendiente |
| Notificaciones proactivas    | 🔲 pendiente |
| Reactivación inactivos       | 🔲 pendiente |

## Arquitectura

```
Cliente WhatsApp
    ↕ Meta Cloud API (Graph API v21.0)
    ↕
lk_whatsapp-webhook (Supabase Edge Function — proyecto PaginaLK)
    ├── bot_conv_get_modo(phone) → bot / humano
    ├── bot_cliente_por_whatsapp(phone) → customer lookup
    ├── (no encontrado) → bot_register_request_v2 → registro
    ├── (encontrado) → Claude Sonnet tool-use:
    │   ├── consultar_mis_pedidos → bot_mis_pedidos RPC
    │   ├── consultar_detalle_pedido → bot_detalle_pedido / bot_detalle_por_indice
    │   ├── consultar_mi_entrega → bot_mi_entrega RPC
    │   ├── buscar_productos → bot_buscar_productos RPC
    │   ├── consultar_mis_descuentos → bot_mis_descuentos RPC
    │   ├── consultar_novedades → bot_productos_novedades RPC
    │   ├── enviar_catalogo → bot_obtener_catalogo_url + send PDF
    │   ├── enviar_fotos_producto → bot_obtener_imagenes_producto + send images
    │   ├── consultar_kb → bot_kb_consultar RPC
    │   └── consultar_mis_top_productos → bot_mis_top_productos RPC
    └── bot_guardar_mensaje → historial

wa_outbox ← triggers order_tracking / pg_cron
    → pg_cron flush → webhook?action=flush → Meta API
```

## Proyectos relacionados

| Proyecto | Repo | Relación |
|----------|------|----------|
| PaginaLK | `loekemeyer/PaginaLK` | Supabase host (kwkclwhmoygunqmlegrg), tablas orders/products/customers, RPCs bot_* |
| Virgilio | `loekemeyer/Produccion-Virgilio` | Tablas whatsapp_clientes, patrón outbox, tracking |
| Planify  | (sin repo git aún) | Template webhook WhatsApp + Claude API |

**Este repo**: `loekemeyer/GestOpClientes` (privado)

## Stack

- **Runtime**: Supabase Edge Functions (Deno/TypeScript)
- **WhatsApp**: Meta Cloud API v21.0
- **IA**: Claude API (Sonnet 4.6 con tool-use para conversación)
- **DB**: PostgreSQL en Supabase (proyecto PaginaLK)
- **Data**: RPCs `bot_*` (security definer, acceso paramétrico)
- **Notificaciones**: pg_cron + wa_outbox

## Estructura

```
GestOpClientes/
├── supabase/
│   └── functions/
│       ├── lk_whatsapp-webhook/    # Webhook principal
│       │   └── index.ts            #   → registro, modo, Claude tool-use
│       └── _shared/                # Utilidades compartidas
│           ├── wa-api.ts           #   Meta Cloud API helpers
│           ├── claude.ts           #   Claude tool-use + ejecución RPCs
│           └── supabase.ts         #   Cliente Supabase (service_role)
├── sql/
│   ├── 001_customer_phones.sql     # (deprecated — usa bot_customer_whatsapps)
│   ├── 002_wa_outbox.sql           # Cola de mensajes salientes
│   ├── 003_wa_order_draft.sql      # Borradores de pedido por WA
│   ├── 004_wa_conversations.sql    # Log de mensajes (auditoría)
│   ├── 005_wa_cron_jobs.sql        # pg_cron para flush/expiración
│   ├── 006_wa_tracking_triggers.sql# Triggers notificación tracking
│   └── 007_bot_submit_order.sql    # RPC envío pedido desde bot
├── docs/
│   ├── PLAN.md                     # Plan de desarrollo detallado
│   ├── DECISIONES.md               # Registro de decisiones técnicas
│   └── FLUJOS.md                   # Diagramas de flujo conversacional
├── CLAUDE.md                       # Instrucciones para Claude Code
└── README.md
```

## Setup

### Requisitos

- Supabase CLI (`supabase`)
- Cuenta Meta WhatsApp Business
- API key Anthropic (Claude)
- Acceso al proyecto PaginaLK en Supabase

### Secrets necesarios (Deno.env / supabase secrets)

| Key | Descripción |
|-----|-------------|
| `LK_WA_PHONE_ID` | WhatsApp Business Phone ID |
| `LK_WA_TOKEN` | Meta API bearer token |
| `LK_WA_VERIFY_TOKEN` | Webhook verification token |
| `ANTHROPIC_API_KEY` | Claude API key |
| `SUPABASE_URL` | URL del proyecto Supabase (automático) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (automático) |
