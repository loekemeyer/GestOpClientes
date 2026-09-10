# Pendientes de seguridad — snapshot 2026-09-09

> Seguible desde otra sesión. Proyecto Supabase **PaginaLK `kwkclwhmoygunqmlegrg`** (compartido
> por el bot GestOp, el sitio pagina-LK, y otras apps: **Milver**, **Virgilio/expo**).
> **La mayoría de los hallazgos son de esas otras apps, NO del bot** — fijar cada uno requiere
> conocer el diseño de la app dueña. No tocar a ciegas: un revoke mal puesto rompe un flujo público.

## A. ✅ HECHO (2026-09-10) — Firma del webhook de Meta (`META_APP_SECRET`) ACTIVA
> El dueño cargó el secret; verificado con un POST de firma inválida → **403**, y tráfico real pasa.
> Rechaza falsificaciones (ya no en modo "avisa"). Detalle abajo (histórico).
El webhook `lk_whatsapp-webhook` es público y hoy **acepta cualquier POST**. El código YA valida
`X-Hub-Signature-256` (`_shared/webhook-firma.ts`) pero arranca en modo "avisa, no rechaza" hasta
que exista el secret `META_APP_SECRET`. Sin eso, cualquiera que sepa la URL inyecta mensajes falsos.

Pasos:
1. Meta: developers.facebook.com → app de WhatsApp LK → **App settings → Basic → App Secret** (Show) → copiar.
2. Supabase → proyecto `kwkclwhmoygunqmlegrg` → **Edge Functions → Secrets** → Add: `META_APP_SECRET` = (el valor). Save.
3. Esperar ~1 min. Mandar un WhatsApp de prueba desde un número de la whitelist (`wa_envio_contactos`).
4. Verificar SIN ambigüedad (el "no contesta" NO sirve para probar el secret — el envío de la
   respuesta es un camino aparte): mandar un POST **forjado** con firma inválida al webhook y
   confirmar que da **403**; y que el tráfico real de Meta siga dejando filas nuevas en
   `wa_inbound_seen`. Hecho el 2026-09-10 vía pg_net: forjado → 403, real → pasa. ✅
   > Nota: el secret estuvo bien desde el primer intento. El "no contestaba" del 2026-09-10 era
   > un bug aparte (`enviarTexto` recursiva, ver más abajo), NO el secret.

Riesgo: secret equivocado → bot mudo, pero **100% reversible** (borrar el secret).
El código: si la firma no coincide → `return 403` sin procesar (`index.ts` ~1458). Setear
`META_APP_SECRET` **no afecta** el flush del outbox (eso va por `LK_INTERNAL_SECRET`, rama aparte).

## A.bis ✅ HECHO (2026-09-10) — `LK_INTERNAL_SECRET` ya no hace falta (puerta muerta retirada)
> Al investigar, la acción interna `{"action":"flush"}` del webhook (lo que `LK_INTERNAL_SECRET`
> gateaba) era **código muerto**: el flush del outbox lo hace el cron `wa_outbox_flush` → edge
> `lk_outbox-flush`, NO el webhook (0 crons/repos activos la llamaban; la def vieja quedó sólo en
> `sql/005`, reemplazada). En vez de cargar un secreto para una puerta sin uso, se **retiró la rama
> de acción interna** del webhook (`lk_whatsapp-webhook/index.ts`): ahora TODO POST pasa por la firma
> de Meta. Verificado: `{"action":"flush"}` forjado → **403**. Sin secreto nuevo, sin tocar crons.
> ⚠️ **Nuevo ítem menor**: `lk_outbox-flush` (el flusher real) es un endpoint público sin auth
> (`verify_jwt=off`, lo llama el cron con body `{}` sin secreto). Riesgo bajo (solo dispara un vaciado
> de cola), pero conviene gatearlo (secret propio o verify_jwt). Anotado abajo.

## B. ✅ YA RESUELTO (verificado 2026-09-10) — `get_customer_sales_history`
> Al leer la definición, la función **ya tiene** el gate `if not exists (admins) raise` adentro.
> No hay leak. Salió del backlog. (El resto de esta sección es el análisis histórico.)

`SECURITY DEFINER`, ejecutable por `authenticated` (verificado 2026-09-09). Un cliente mayorista
logueado en la web LK puede leer el histórico de compras de OTRO pasando su código.
- Fix SIN romper: NO revocar el EXECUTE (rompe los paneles admin que la usan). Agregar el chequeo
  adentro: `if not exists (select 1 from admins where auth_user_id = auth.uid()) then raise exception ...`.
- Antes de tocar: verificar en el repo **pagina-LK-copia** que TODOS los call-sites sean pantallas de
  admin (`admin.js`, `analisis-venta-cliente.js`). Si alguna pantalla de cliente la usa → se rompe.
- Es del proyecto pagina-LK (no del bot). Coordinar con esa sesión.

## Advisors de Supabase (corridos 2026-09-09) — backlog grande, mayormente de OTRAS apps
`get_advisors(security)` sobre `kwkclwhmoygunqmlegrg`. Totales:

| # | Hallazgo | Nivel | Qué es |
|---|----------|-------|--------|
| 45 | `anon_security_definer_function_executable` | WARN | funciones SECURITY DEFINER que puede llamar **anon** (sin login) |
| 224 | `authenticated_security_definer_function_executable` | WARN | ídem, cualquier logueado |
| 7 | `security_definer_view` | ERROR | vistas SECURITY DEFINER (corren como el creador, saltean RLS) |
| 7 | `rls_disabled_in_public` | ERROR | tablas sin RLS expuestas a la API |
| 4 | `foreign_table_in_api` | WARN | foreign tables de **Chef** legibles por anon (no respetan RLS) |
| 3 | `materialized_view_in_api` | WARN | MVs de ventas legibles por anon/auth |
| 121 | `function_search_path_mutable` | WARN | funciones sin `search_path` fijo |
| 89 | `rls_enabled_no_policy` | INFO | RLS prendida sin policy (bloquea todo — casi todo benigno) |
| 3 | `extension_in_public` | WARN | extensiones en `public` (pg_trgm, etc.) |

### Triage de las 45 ejecutables por anon
- **La mayoría son intencionales**: `milver_*` (app Milver, auth por **PIN dentro** de la función,
  arg `p_pin`), `lookup_cuit_by_username` (login LK, tiene que ser anon), expo. NO tocar sin entender.
- **Revisadas 2026-09-10 (leyendo `pg_get_functiondef`) — casi todas YA gatean adentro:**
  - `fijar_dto_escala(p_customer_id, p_dto)` — ✅ **NO es vulnerable**: exige `auth.uid()` = el propio
    cliente o admin (+ `escala_activa`). Anon → `RAISE 'no autorizado'`. Revocar anon rompería el
    auto-servicio de escala. **No tocar.**
  - `buscar_cliente_ficha(p_q)` — ✅ gate `admins` adentro. No tocar.
  - `get_ficha_cliente(p_cod)` — ✅ gate `admins` adentro. No tocar.
  - `get_customer_sales_history(p_customer_code)` — ✅ gate `admins` adentro (el ítem B ya estaba
    resuelto; salió del backlog).
  - `fn_ventas_mensuales_virgilio(p_cod, p_meses)` — ✅ **CERRADO (2026-09-10)** con gate por header
    secreto compartido. La función es `LANGUAGE sql`: se le agregó un CTE `gate` que compara el header
    `x-feed-secret` (PostgREST lo expone en `current_setting('request.headers')`) contra
    `app_settings.virgilio_feed_secret` (LK), y un cross-join → si no matchea, 0 filas (fail-closed,
    devuelve `[]`, no rompe). Del lado Virgilio, `ventas_mensuales_cod` (proyecto `hrxfctzncixxqmpfhskv`)
    ahora manda ese header en su llamada `http()`. **Rollout sin downtime**: primero Virgilio empezó a
    mandar el header (LK viejo lo ignoraba), después LK pasó a exigirlo. Verificado: anon sin secreto →
    `[]`; con secreto → datos; `ventas_mensuales_cod('505',6)` de Virgilio → 6 meses OK.
    Secreto en `app_settings` key `virgilio_feed_secret` (anon NO lo lee, sql/061 lo tapa) y embebido
    en la función de Virgilio (mismo nivel que la anon key que ya vivía ahí). **anon quedó con EXECUTE
    pero inútil** (el gate está adentro; mismo patrón que `fijar_dto_escala`).
  - `registrar_descarga_fotos`, `fotos_descarga_estado`, `virgilio_volumen_map` — revisar, probablemente benignos.
  - `trg_*` (3) son funciones de trigger, no deberían estar expuestas como RPC (inocuo pero sucio).
- **Lección**: el advisor marca "ejecutable por anon" pero NO ve el gate interno. Antes de revocar,
  leer la definición (`pg_get_functiondef`) — la mayoría de las 45 gatean adentro (o por PIN, milver_*).

### `foreign_table_in_api` (4) — ✅ HECHO (2026-09-10)
> Revocado `all` a `anon` + `authenticated` en `chef_customers`, `chef_customer_delivery_addresses`,
> `chef_sales_lines`, `chef_orders`. `service_role` intacto. Verificado: anon bloqueado.
> **Era GRAVE**: `chef_orders` tenía `anon` con INSERT/UPDATE/DELETE/TRUNCATE (vía FDW, escribía a Chef).
> Confirmado antes de tocar que NO rompe nada: el bot no las usa (y usa service_role, no anon), 0
> `.from("chef_")` en los 4 repos, y las 6 funciones que las leen son SECURITY DEFINER (corren como
> owner). Histórico abajo.

### `foreign_table_in_api` (4) — leak del padrón de Chef (histórico) 🟠
`chef_customers`, `chef_customer_delivery_addresses`, `chef_sales_lines`, `chef_orders` son foreign
tables (FDW) accesibles por la API y **NO respetan RLS** → anon podría leer todo el padrón/ventas de
Chef vía REST. Fix: revocar SELECT a anon/authenticated sobre esas foreign tables (las usan RPCs
internas con service_role, no el front directo — verificar antes).

### `rls_disabled_in_public` (7) — ✅ HECHO (2026-09-10)
> Cerradas: `enable row level security` + `revoke all from anon, authenticated` en las 7. Verificado:
> `anon`/`authenticated` ya no leen, `service_role` sigue (bypassrls). Los `_rank_*` tenían 368 filas
> con valorización de clientes. Detalle histórico abajo.

### `rls_disabled_in_public` (7) — QUICK WIN SEGURO (histórico)
Son todas tablas de **backup/temporales** legibles por anon, sin uso en ninguna app:
`_rank_antes_20260904`, `_rank_despues_20260904`, `wa_faq_bkp_20260908`, `wa_faq_bkp_20260908_faq15`,
`_backup_funcdefs_20260903`, `_backup_funcdefs_20260904`, `_migracion_precios_20260904`.
Fix seguro: `alter table ... enable row level security;` (sin policy → bloquea anon/auth, queda
service_role) o dropearlas si ya no se necesitan. Cero impacto funcional (ninguna app lee un `_backup_*`).

### `security_definer_view` (7)
`v_customer_item_month`, `v_orders_origen`, `v_clientes_arca`, `estadistica_madre`, `v_wa_faq_summary`,
`expo_dashboard_stats`, `leads_overview`. Recrearlas con `security_invoker = true` (revisar que no
dependan de correr como owner para saltear RLS a propósito).

## C. ✅ HECHO (2026-09-10) — `sales-agent` ya no corre SQL write-capable
> Antes: el SQL del LLM se ejecutaba con `exec_raw_sql` (service_role, write-capable) y el único
> filtro era texto (flojo: no bloqueaba TRUNCATE/ALTER/GRANT ni sentencias apiladas). Ahora corre por
> la RPC nueva **`sales_agent_ro(p_sql)`** (SECURITY INVOKER; `revoke` a public/anon/authenticated,
> `grant` sólo a service_role) que: (1) exige SELECT/WITH de UNA sentencia (sin `;` apilado), y
> (2) **`set local transaction_read_only = on` + statement_timeout 15s** → cualquier escritura falla
> EN EL MOTOR, aunque se cuele por el texto. Verificado: SELECT válido devuelve datos; `nextval()`
> (write que pasa el filtro de texto) → `ERROR: cannot execute nextval() in a read-only transaction`.
> Edge `sales-agent` redeployada (v15) para usar la RPC + filtro de texto endurecido como
> pre-chequeo. Sigue admin-only. Ningún front la consume (era huérfana). `exec_raw_sql` sin cambios
> (lo usan otros con service_role); sales-agent ya no lo toca.

## D. ✅ HECHO (2026-09-10) — `lk_wh_stage` neutralizado
> Segundo webhook público con lógica vieja del bot. **Verificado que nada lo usa**: Meta apunta a
> `lk_whatsapp-webhook` (probado — los mensajes de Luis crearon `wa_inbound_seen` y recibieron la
> respuesta post-fix de `enviarTexto`, ambos código del webhook real; Meta = 1 callback URL), 0 crons,
> 0 referencias en los 4 repos, no versionado (deploy manual). Se **redeployó como stub 410 Gone**
> (v8, y quedó `verify_jwt=true`) → lógica vieja muerta, superficie cerrada. Probado: POST → 410.
> **No se pudo BORRAR del todo por MCP** (no hay delete_edge_function); el borrado final es opcional
> desde el dashboard de Supabase (cosmético — ya está inerte).

> ✅ **`whatsapp-webhook` (v157) — YA neutralizado (verificado 2026-09-10, sin acción).** Al leer el
> código deployado, es el **stub documentado** (`legacy/whatsapp-webhook-v151/`, stubeado 2026-09-01):
> GET → challenge sólo si el verify_token coincide; POST de Meta → `200 ok` y **descarta el payload
> sin procesar nada** (probado: POST falso → 0 rastros en ninguna tabla); POST `x-internal-resume` →
> 503. `verify_jwt=off` a propósito (para que la verificación GET de Meta siga viva). Nada que hacer.

## E. Tokens en `app_settings`
`LK_WA_TOKEN` e `isis_supabase_service_key` viven en una tabla en vez del Vault. Mover a secrets de
edge function + rotar. Grepear todos los lectores antes.

---
## Estado al 2026-09-10
- ✅ **A** — firma del webhook (`META_APP_SECRET`) activa y verificada (403 en forjado).
- ✅ **Backups sin RLS (7)** — cerradas (RLS + revoke anon/auth).
- ✅ **Foreign tables Chef (4)** — revocado anon/auth (era GRAVE: DELETE/TRUNCATE por anon).
- ✅ **B `get_customer_sales_history`** — ya tenía gate admin. `fijar_dto_escala`, `buscar_cliente_ficha`,
  `get_ficha_cliente` — ya gatean adentro (NO tocar).

- ✅ **`fn_ventas_mensuales_virgilio`** — cerrado con gate por header secreto (`virgilio_feed_secret`);
  Virgilio actualizado para mandarlo. anon sin secreto → `[]`. Verificado en ambos lados.
- ✅ **MVs `mv_chef_sales_loke` / `mv_loke_sales_agg` / `mv_chef_customers_resolved`** (2026-09-10) —
  revocado anon/auth (`service_role` intacto). Verificado: 0 fronts las leen, 0 vistas dependen, las
  6 funciones que las usan son SECURITY DEFINER. Cierra `materialized_view_in_api`.
- ✅ **`lk_wh_stage`** (2026-09-10) — neutralizado a stub 410 (nada lo usaba; Meta va a
  `lk_whatsapp-webhook`). Borrado final opcional desde el dashboard.

- ✅ **`whatsapp-webhook` (v157)** (2026-09-10) — ya era el stub documentado (neutralizado 2026-09-01);
  verificado leyendo el código deployado. Sin acción.

- ✅ **`sales-agent`** (2026-09-10) — SQL del LLM ahora corre read-only (RPC `sales_agent_ro`); ya no usa `exec_raw_sql`.
- ✅ **`LK_INTERNAL_SECRET` / acción interna del webhook** (2026-09-10) — era código muerto; se retiró la rama, todo POST exige firma de Meta. Verificado `action=flush` → 403.

**Quedan (por prioridad):**
1. 🟡 Rotar `LK_WA_TOKEN`/`isis_supabase_service_key` (app_settings → Vault). **Requiere tu mano.**
2. 🟢 `lk_outbox-flush` — endpoint público sin auth (flusher real del outbox). Gatearlo (secret o verify_jwt). Riesgo bajo. **Lo puedo hacer solo** (ojo: hay que actualizar el cron `wa_outbox_flush` en el mismo paso).
3. 🟢 hardening de fondo (`function_search_path_mutable` 121, `security_definer_view` 7, `extension_in_public` 3). **Lo puedo hacer solo.**
5. 🟢 `function_search_path_mutable` (121) / `security_definer_view` (7) / `extension_in_public` (3) — hardening de fondo, bajo riesgo.
