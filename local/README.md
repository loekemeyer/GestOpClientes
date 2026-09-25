# Sandbox local — "tocar sin miedo a romper"

Entorno de prueba aislado para iterar la **lógica del bot** sin tocar producción
(`PaginaLK`, `kwkclwhmoygunqmlegrg`). Pensado como punto de partida del proyecto de
trace/observabilidad.

## ⚠ Antes de empezar: dos trampas

1. **No hay credenciales en la rama.** Los secrets viven en el Vault / secrets de Edge
   Function y en `app_settings`. Nunca los pegues en git.
2. **El `.env.local.example` de la raíz apunta a PRODUCCIÓN** (`SUPABASE_URL` = el proyecto
   real, con `service_role`). Correr `functions serve` con ese `.env` = **código local contra
   la base de prod**: las lecturas son inofensivas, pero cualquier escritura rompe prod, y
   `npm run db:down` (= `supabase db reset`) mal apuntado es una bomba. Para el sandbox usá
   `local/.env.local.sandbox` (apunta a `127.0.0.1`), nunca el de la raíz.

## Alcance de este sandbox (v1)

Cubre el **camino FAQ (0 IA)**, que es self-contained: `wa_faq` + el matcher `wa_faq_match`
(unaccent + pg_trgm). **No** reproduce el agente IA, las tools de pedidos ni los datos que en
prod llegan por **FDW** desde Gestión/ISIS (eso no vive en un Postgres local). Es la base
mínima para correr y medir; las capas siguientes (agente/tools) se agregan de a una.

## Correrlo

**Opción A — Postgres descartable (lo más rápido, solo necesita Docker):**
```bash
./local/bootstrap.sh
```
Levanta `postgres:16` (contenedor `bot-sandbox`, puerto 55432), carga esquema + seed real +
matcher, y corre el smoke test. Borrar con `docker rm -f bot-sandbox`.

**Opción B — sobre tu Supabase local** (`supabase start`, DB en el puerto 54322):
```bash
supabase start
./local/bootstrap.sh "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
cp local/.env.local.sandbox .env.local   # + completá ANTHROPIC_API_KEY si querés IA
npm run dev:test                          # sirve lk_chat-test en localhost:54321
npm run test:faq:local                    # corre tests/faq-tests.sh
```

## Qué valida el smoke test

Corre `wa_faq_match` contra preguntas típicas y confirma que cada una cae en la FAQ correcta
(`score ≥ 1`) y que el input basura queda en `0` (→ se derivaría a IA/registro). Resultado
esperado (validado 2026-09-25):

| pregunta | categoría | score |
|---|---|---|
| no me llegó la factura | facturacion_comprobante | 9.001 |
| cuál es el mínimo de compra | minimo_compra | 4.001 |
| ¿Como pago? | pago_cbu_formas | 3.001 |
| quiero hacer un pedido | hacer_modificar_pedido | 3.001 |
| donde retiro | retiro_deposito | 3.001 |
| cuando llega mi pedido | transporte_fecha_entrega | 2.001 |
| necesito mi contraseña | web_registro_contrasena | 1.001 |
| asdfqwer zzz nada | — | 0.000 (sin match) |

## Fuente de verdad

- Esquema + matcher: `local/01-faq-schema.sql` (fiel a `sql/007` + `sql/054`).
- Seed: **no se duplica** — `bootstrap.sh` extrae el `INSERT` real de `sql/007_wa_faq.sql` en
  runtime. Si cambia el seed en prod, actualizá `sql/007` y el sandbox lo toma solo.

## Próximo paso

Agregar la capa de **trace** (instrumentar `runConversation`) sobre este sandbox, para ver el
flujo tipo n8n y medir tokens antes de optimizar.
