# Sandbox local — "tocar sin miedo a romper"

Entorno de prueba aislado para iterar la **lógica del bot** y construir la **capa de
trace/observabilidad** sin tocar producción (`PaginaLK`, `kwkclwhmoygunqmlegrg`).

## ⚠ Antes de empezar: dos trampas

1. **No hay credenciales en la rama.** Los secrets viven en el Vault / secrets de Edge
   Function y en `app_settings`. Nunca los pegues en git.
2. **El `.env.local.example` de la raíz apunta a PRODUCCIÓN** (`SUPABASE_URL` = el proyecto
   real, con `service_role`). Correr `functions serve` con ese `.env` = **código local contra
   la base de prod**: lecturas inofensivas, pero cualquier escritura rompe prod, y
   `npm run db:down` (= `supabase db reset`) mal apuntado es una bomba. Para el sandbox usá
   `local/.env.local.sandbox` (apunta a `127.0.0.1`), nunca el de la raíz.

## Qué monta (3 capas self-contained)

| archivo | capa | qué trae |
|---|---|---|
| `01-faq-schema.sql` | **FAQ (0 IA)** | `wa_faq` + matcher `wa_faq_match` (fiel a `sql/007`+`sql/054`) |
| `02-agent-mocks.sql` | **Agente (mock)** | `wa_identify_customer`, historial, y tools (`bot_mis_pedidos`, `bot_mi_entrega`, `bot_mis_descuentos`, `bot_detalle_pedido`) con las **firmas reales de prod** y **datos sembrados** |
| `03-trace.sql` | **Trace** | tabla `bot_trace` + `bot_trace_log(jsonb)`: un registro por mensaje (compuerta, tools, modelo, tokens, latencia, decisión) |

**No** reproduce los datos que en prod llegan por **FDW** desde Gestión/ISIS: las tools son
mocks con datos ficticios (no consultan `orders`/`products`/`customers` de verdad). Alcanza
para correr `runConversation`, ver el flujo y construir el trace; la conexión real a esos datos
es prod, no sandbox.

## Correrlo

**Opción A — Postgres descartable (lo más rápido, solo Docker):**
```bash
./local/bootstrap.sh
```
Levanta `postgres:16` (contenedor `bot-sandbox`, puerto 55432), carga las 3 capas + el seed real
de FAQs, y corre el smoke test. Borrar: `docker rm -f bot-sandbox`.

**Opción B — sobre tu Supabase local** (`supabase start`, DB en 54322):
```bash
supabase start
./local/bootstrap.sh "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
cp local/.env.local.sandbox .env.local   # + ANTHROPIC_API_KEY si querés IA
npm run dev:test                          # sirve lk_chat-test en localhost:54321
npm run test:faq:local                    # tests/faq-tests.sh
```

## Qué valida el smoke test (corrido 2026-09-25)

- **FAQ**: cada pregunta cae en la FAQ correcta (`score ≥ 1`); el input basura queda en `0` (→ IA).
- **Agente**: `wa_identify_customer('1166574113')` → cliente sandbox; `bot_mis_pedidos`/`bot_mi_entrega`
  devuelven los pedidos sembrados.
- **Historial**: guardar + leer conserva la conversación.
- **Trace**: `bot_trace_log(...)` inserta una fila con gate/modelo/iterations/outcome.

## Fuente de verdad

- Esquema/matcher/mocks: `local/0*.sql` (fieles a las firmas reales verificadas en prod).
- Seed FAQ: **no se duplica** — `bootstrap.sh` extrae el `INSERT` de `sql/007_wa_faq.sql` en runtime.

## Próximo paso (proyecto de trace)

Instrumentar `runConversation` (en `supabase/functions/_shared/bot-conversation.ts`) para armar un
`jsonb` por mensaje y llamar `bot_trace_log(p)` una vez al final del turno. Eso enciende la vista
tipo n8n y la medición de tokens. Ese cambio toca el webhook real → **deploya por CI** y va en su
propia pasada, con la migración `sql/NNN` de `bot_trace` (con RLS ON, solo `service_role`) para prod.
