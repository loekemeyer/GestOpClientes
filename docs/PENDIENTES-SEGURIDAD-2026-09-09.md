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
4. Verificar: el bot contesta = OK. No contesta = secret mal → **borrar el secret** (vuelve al estado seguro actual) y reintentar.
5. Verificación por logs (una sesión Claude): que el webhook deje de loguear `META_APP_SECRET sin cargar`
   y que NO aparezca `[firma] POST rechazado: firma no coincide` con tráfico real de Meta.

Riesgo: secret equivocado → bot mudo, pero **100% reversible** (borrar el secret).
El código: si la firma no coincide → `return 403` sin procesar (`index.ts` ~1458). Setear
`META_APP_SECRET` **no afecta** el flush del outbox (eso va por `LK_INTERNAL_SECRET`, rama aparte).

## A.bis `LK_INTERNAL_SECRET` (acciones internas tipo `{"action":"flush"}`)
Mismo patrón "avisa, no rechaza". **Ojo:** si se carga el secret hay que ACTUALIZAR TAMBIÉN el
`pg_cron` que dispara el flush para que mande el header `x-lk-internal-secret`, o el outbox deja de
mandar. Hacerlo junto, no suelto.

## B. 🟠 `get_customer_sales_history` — la ejecuta cualquier `authenticated`
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
- **Revisar SÍ o SÍ (sin auth aparente, filtran/escriben datos):**
  - `fijar_dto_escala(p_customer_id, p_dto)` — **ESCRIBE un descuento**, sin pin/gate → anon podría
    cambiar descuentos. 🔴 Confirmar si tiene gate interno; si no, revocar anon o agregar gate.
  - `buscar_cliente_ficha(p_q)` — busca fichas de cliente → leak.
  - `get_ficha_cliente(p_cod)` — ficha por código → leak.
  - `fn_ventas_mensuales_virgilio(p_cod, p_meses)` — ventas mensuales por código → leak.
  - `registrar_descarga_fotos`, `fotos_descarga_estado`, `virgilio_volumen_map` — revisar, probablemente benignos.
  - `trg_*` (3) son funciones de trigger, no deberían estar expuestas como RPC (inocuo pero sucio).

### `foreign_table_in_api` (4) — leak del padrón de Chef 🟠
`chef_customers`, `chef_customer_delivery_addresses`, `chef_sales_lines`, `chef_orders` son foreign
tables (FDW) accesibles por la API y **NO respetan RLS** → anon podría leer todo el padrón/ventas de
Chef vía REST. Fix: revocar SELECT a anon/authenticated sobre esas foreign tables (las usan RPCs
internas con service_role, no el front directo — verificar antes).

### `rls_disabled_in_public` (7) — 🟢 QUICK WIN SEGURO (pendiente de OK)
Son todas tablas de **backup/temporales** legibles por anon, sin uso en ninguna app:
`_rank_antes_20260904`, `_rank_despues_20260904`, `wa_faq_bkp_20260908`, `wa_faq_bkp_20260908_faq15`,
`_backup_funcdefs_20260903`, `_backup_funcdefs_20260904`, `_migracion_precios_20260904`.
Fix seguro: `alter table ... enable row level security;` (sin policy → bloquea anon/auth, queda
service_role) o dropearlas si ya no se necesitan. Cero impacto funcional (ninguna app lee un `_backup_*`).

### `security_definer_view` (7)
`v_customer_item_month`, `v_orders_origen`, `v_clientes_arca`, `estadistica_madre`, `v_wa_faq_summary`,
`expo_dashboard_stats`, `leads_overview`. Recrearlas con `security_invoker = true` (revisar que no
dependan de correr como owner para saltear RLS a propósito).

## C. `sales-agent` — SQL de un LLM con service_role (pagina-LK)
Edge function que le pasa SQL generado por IA a `exec_raw_sql` con service_role; filtro por texto
flojo. Detrás de gate admin (alcance limitado). Fix: correr con rol solo-lectura + endurecer parser.

## D. `lk_wh_stage` — webhook fantasma
Segundo webhook público, sin JWT, NO versionado en el repo, con lógica vieja del bot (sin
anti-jailbreak). Decidir borrarlo o traerlo al repo. Antes de borrar: confirmar que Meta no lo tenga
configurado como webhook activo.

## E. Tokens en `app_settings`
`LK_WA_TOKEN` e `isis_supabase_service_key` viven en una tabla en vez del Vault. Mover a secrets de
edge function + rotar. Grepear todos los lectores antes.

---
**Prioridad sugerida:** A (dueño, alto impacto) → `fijar_dto_escala` + foreign tables Chef (leaks/escritura
anon reales) → B → quick-win backup tables → C/D/E.
