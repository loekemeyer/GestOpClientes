# ESTADO — mapa vivo del sistema

> **Leer esto (y `git log --oneline -20`) al empezar cualquier sesión.**
> **Actualizarlo al cerrar** cuando cambies flags, flujos o arquitectura.
> Última actualización: 2026-09-02.

## Dos proyectos Supabase (¡importante!)

| Proyecto | ID | Qué tiene |
|----------|----|-----------|
| **PaginaLK** | `kwkclwhmoygunqmlegrg` | Bot WhatsApp, webhook, front (`docs/index.html`), `app_settings`, `wa_*`, edge functions `lk_*`. |
| **ISIS** | `hrxfctzncixxqmpfhskv` | Facturación: `Facturacion_NP`, `PPP_Programacion_Diaria`, `vista_cola_impresion`, `wa_pipeline_log`, RPC `wa_dashboard_rango`. También el **login Google** del dashboard. |

El dashboard de la página lee del **pipeline de facturas que vive en ISIS**. Si algo de facturación no cuadra, la data está en ISIS, no en PaginaLK.

## Dashboard "Pipeline de facturas" — de dónde sale cada número

RPC `wa_dashboard_rango(desde,hasta)` (ISIS), vía edge `lk_notif-sim` action `dashboard`:
- **programados** = `PPP_Programacion_Diaria` por `fecha_entrega`
- **armados** = `vista_cola_impresion` por `armado_ts`
- **facturados** = `Facturacion_NP` por `facturado_at` (distinct **NP**)
- **enviadas** (dashboard: "📤 Mensajes enviados") = `wa_pipeline_log` event `aviso_enviado` — **una fila por (grupo × destinatario)**, NO por NP. Con 2 destinatarios de prueba, cada envío cuenta doble.
- **facturas_enviadas** = facturas cubiertas por avisos enviados, **dedup por grupo** (mismo grupo a 2 destinatarios cuenta 1 vez). El front lo muestra como `(x de y)` = `(facturas_enviadas de facturados)` al lado de Mensajes enviados.

⚠️ "facturados" (NP) y "Mensajes enviados" (avisos por destinatario) **no son la misma unidad** — por eso se agregó `(x de y)`.

## Flujo de envío de factura (producción, hoy en modo prueba)

1. Operadora factura una NP → impacta en ISIS (`Facturacion_NP` / `documentos`).
2. Trigger **`wa_factura_notificar`** (ISIS) → loguea `factura_generada` y hace `http_post` a **`lk_factura-check`** (PaginaLK).
3. `lk_factura-check` → `handleRealRedirect`: agrupa las facturas del día por **cuit + empresa + dirección**, arma el mensaje + combina PDFs, y **entrega a los números de `wa_real_redirect_to`** (nunca al cliente en modo prueba). Loguea `aviso_enviado` por destinatario.
4. Backlog manual del día: edge `lk_notif-sim` action **`real_sweep`** (recorre los cuits facturados de hoy y redispara `lk_factura-check`).

**Regla método-mixto (dentro de un grupo cuit+empresa+destino):**
- El método se lee **por factura** (RPC `wa_grupos_dia_cuit` → `metodos_fac[]`, alineado con comprobantes/totales/paths).
- **1 método real + "prefiere no decir" (no_decidido)** → las no_decidido se **asumen** de ese método → **un solo mensaje** (ej. SANLOZ: 2×credito_15_30 + 1×no_decidido → las 3 como credito_15_30).
- **0 métodos reales** (todas no_decidido) → un mensaje no_decidido.
- **≥2 métodos reales distintos** → **un mensaje por método** (split, con el método en la `group_key` y en el nombre del PDF). Las no_decidido en ese caso quedan **retenidas** (`held_metodo_mixto`): ambiguo, no se adivina a qué grupo van.
- Excepción por cliente (`wa_descuentos_config`) fuerza un método y anula el split.

**Retenciones (no se envían):**
- `held_metodo_mixto` — sólo cuando hay ≥2 métodos reales y quedan facturas no_decidido ambiguas (ver regla arriba).
- `held_tpl_no_aprobada` — la plantilla de Meta no está en estado APPROVED.

**Reintento automático (no se pierde nada si algo falla):**
- Cron `wa_barrido_avisos` (ISIS, cada 15 min) reprocesa los cuits facturados de **hoy y ayer** (ventana 48h) llamando a `lk_factura-check`. Idempotente (salta lo ya enviado). Recupera facturas que quedaron sin mandar por parser lento, config activada tarde o error transitorio.
- `handleRealRedirect` acepta facturas con `fecha` dentro de la ventana de 48h (antes sólo `fecha === hoy`, por eso ayer 3 clientes quedaron sin enviar tras la medianoche).

## Flags críticos (`app_settings`, PaginaLK)

| key | qué hace | valor al 2026-09-02 |
|-----|----------|---------------------|
| `wa_real_redirect_to` | destino(s) de prueba de las facturas, coma-sep. Deben estar en la whitelist `wa_envio_contactos`. | `5491125608669` (Luis) |
| `wa_real_redirect_date` | **ventana de 48h**: el envío real ocurre ese día Y el siguiente (`dentroVentana` en `lk_factura-check`). Si la fecha quedó a >1 día, se apaga solo. Rearmar cuando arranca una tanda de prueba. | `2026-09-02` (activo 02 y 03/09) |
| `wa_factura_envio_modo` | `modulo` (chat de prueba) / `whatsapp` (real) | `modulo` |
| `wa_bot_solo_whitelist` | killswitch del bot de chat: `1` = solo responde a `wa_envio_contactos` | `1` |
| `wa_comprobantes_activo` | flujo de comprobantes entrantes: `0` apagado / `1` on | `0` |

`wa_envio_contactos` = **lista blanca**: el bot solo envía a estos números. Hoy incluye a Thomy (`5491162521635`) y Luis (`5491125608669`).

## Bot de chat (webhook)

- Edge `lk_whatsapp-webhook` (v16, `verify_jwt=false`). Flujo: whitelist gate → modo humano → FAQ (`wa_faq`) → registro por CUIT → agente IA.
- FAQ categorías: AUTO/SEMIAUTO/IA/HUMANO. Pestaña "Preguntas frecuentes" en el front lee `wa_faq` + `wa_faq_lookup_tokens`. Escritura solo vía `lk_faq-admin` (admin). Ver regla de sincronización en `CLAUDE.md`.
- Registro por CUIT: valida módulo 11; CUIT inválido → avisa; guarda historial.

## Edge functions que NO están en este repo (solo desplegadas)

`lk_notif-facturado` (path viejo, redirige a un número de test — en desuso), `lk_outbox-flush` (cron cada 2 min manda `wa_outbox`). Para verlas: `mcp Supabase get_edge_function`. Si las tocás, considerá traerlas al repo.

## Front

`docs/index.html`, servido por GitHub Pages desde `main`. Badge de versión abajo a la derecha (hoy `v0.16.1`). Bumpear con cada cambio de front.
