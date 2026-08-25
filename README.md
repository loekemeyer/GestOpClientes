# BotWA-LK — Bot WhatsApp Clientes Loekemeyer

Bot conversacional WhatsApp para gestión de clientes mayoristas de Loekemeyer Hnos S.R.L.

## Qué hace

| Feature                      | Estado     |
|------------------------------|------------|
| Identificación de cliente    | ✅ hecho   |
| Consulta estado de pedido    | ✅ hecho   |
| IA conversacional general    | ✅ hecho   |
| Notificaciones proactivas    | 🔲 pendiente |
| Recepción de pedidos por WA  | 🔲 pendiente |
| Reactivación clientes inactivos | 🔲 pendiente |

## Arquitectura

```
Cliente WhatsApp
    ↕ Meta Cloud API (Graph API v21.0)
    ↕
lk_whatsapp-webhook (Supabase Edge Function — proyecto PaginaLK)
    ├── identify_customer(phone) → customers.whatsapp
    ├── parse_intent(Claude haiku) → consulta / pedido / otro
    ├── consulta → orders + order_tracking → respuesta
    ├── pedido → wa_order_draft → submit_order_fast RPC
    └── otro → Claude conversacional con contexto negocio

wa_outbox ← triggers order_tracking / pg_cron inactivos
    → pg_cron flush → webhook?action=flush → Meta API
```

## Proyectos relacionados

| Proyecto | Repo | Relación |
|----------|------|----------|
| PaginaLK | `loekemeyer/PaginaLK` | Supabase host (kwkclwhmoygunqmlegrg), tablas orders/products/customers |
| Virgilio | `loekemeyer/Produccion-Virgilio` | Tablas whatsapp_clientes, patrón outbox, tracking |
| Planify  | (sin repo git aún) | Template webhook WhatsApp + Claude API |

**Este repo**: `loekemeyer/GestOpClientes` (privado)

## Stack

- **Runtime**: Supabase Edge Functions (Deno/TypeScript)
- **WhatsApp**: Meta Cloud API v21.0
- **IA**: Claude API (haiku para parsing, sonnet para conversacional)
- **DB**: PostgreSQL en Supabase (proyecto PaginaLK)
- **Notificaciones**: pg_cron + wa_outbox

## Estructura

```
BotWA-LK/
├── supabase/
│   └── functions/
│       ├── lk_whatsapp-webhook/    # Webhook principal
│       │   └── index.ts
│       └── _shared/                # Utilidades compartidas
│           ├── wa-api.ts           # Meta Cloud API helpers
│           ├── claude.ts           # Claude API helpers
│           └── supabase.ts         # Cliente Supabase
├── sql/
│   ├── 001_customer_phones.sql     # Vinculación teléfono-cliente
│   ├── 002_wa_outbox.sql           # Cola de mensajes salientes
│   ├── 003_wa_order_draft.sql      # Borradores de pedido por WA
│   ├── 004_wa_cron_flush.sql       # pg_cron para flush outbox
│   └── 005_clientes_inactivos.sql  # Vista + cron reactivación
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

### Secrets necesarios (en `app_settings` de PaginaLK)

| Key | Descripción |
|-----|-------------|
| `LK_WA_PHONE_ID` | WhatsApp Business Phone ID |
| `LK_WA_TOKEN` | Meta API bearer token |
| `LK_WA_VERIFY_TOKEN` | Webhook verification token |
| `ANTHROPIC_API_KEY` | Claude API key |
