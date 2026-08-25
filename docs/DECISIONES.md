# Registro de decisiones — BotWA-LK

## D001 — Repo separado (2026-08-25)

**Decisión**: Crear repo independiente `BotWA-LK` en vez de meter el bot dentro de PaginaLK o Virgilio.

**Razón**: El bot es un conector entre PaginaLK (pedidos, productos, clientes), Virgilio (tracking, stock) y Planify (patrón webhook). No pertenece a ninguno. Repo propio permite deploy independiente y claridad de ownership.

**Consecuencia**: Edge Functions se deployean desde este repo al proyecto Supabase de PaginaLK. Las SQL migrations se aplican al mismo proyecto.

---

## D002 — Reusar proyecto Supabase PaginaLK (2026-08-25)

**Decisión**: Las tablas y edge functions del bot viven en el proyecto Supabase de PaginaLK (`kwkclwhmoygunqmlegrg`), no en un proyecto nuevo.

**Razón**: El bot necesita acceso directo a `orders`, `order_items`, `products`, `customers` — todas en PaginaLK. Un proyecto separado requeriría cross-project queries o replicación. Innecesario.

**Consecuencia**: Compartir RLS policies. Prefijo `wa_` en tablas nuevas para distinguir.

---

## D003 — Patrón Planify para webhook (2026-08-25)

**Decisión**: Copiar y adaptar el webhook de Planify (`planify_whatsapp-webhook/index.ts`) como base.

**Razón**: Ya resuelve Meta Cloud API v21.0, verificación, media, Claude API directo. Probado en producción. Adaptar > reinventar.

---

## D004 — Claude API directo (sin SDK) (2026-08-25)

**Decisión**: Usar HTTP directo a `api.anthropic.com/v1/messages`, sin SDK.

**Razón**: Planify ya lo hace así. Deno en Edge Functions no siempre se lleva bien con el SDK npm. HTTP directo = 0 dependencias, control total.

---

## D005 — Número WhatsApp (pendiente)

**Decisión**: TBD — ¿número nuevo o compartir con Planify?

**Opciones**:
- **Número nuevo**: Aislamiento total, branding propio. Costo: ~$15/mes meta + verificación.
- **Compartir**: Router por contexto (si el teléfono es cliente → BotWA-LK, si es empleado → Planify). Ahorra costo pero acopla.

**Nota**: Meta permite 1 webhook por app, pero se puede routear en un proxy.
