# ESTADO — mapa vivo del sistema

> **Leer esto (y `git log --oneline -20`) al empezar cualquier sesión.**
> **Actualizarlo al cerrar** cuando cambies flags, flujos o arquitectura.
> Última actualización: 2026-09-04.

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

**Método mixto (Reglas A/B, helper `planMetodos` en `lk_factura-check`):**
- **Regla A**: si el grupo tiene UN solo método real + facturas `no_decidido` ("prefiero no decir"),
  las `no_decidido` **adoptan ese método** → un solo mensaje (ej.: crédito + no_decidido = todo crédito).
- **Regla B**: si hay ≥2 métodos reales distintos, el grupo se **PARTE** (un mensaje por método, con
  PDF propio). Las `no_decidido` se absorben en un método ya presente: **contado** si está entre los
  reales; si no, el método real de **menor descuento** (desempate: más facturas → orden → nombre).
  Nunca inventa un grupo contado que el pedido no tenía.
- **Excepción por cliente** (`wa_descuentos_config.excepciones`) fuerza método e ignora el mixto.
- `held_metodo_mixto` sólo queda en `handleGrupo` (`mode:grupo`) si llega el set de métodos distinto
  sin método por-factura y hay ≥2 reales. Los caminos activos (real por `wa_grupos_dia_cuit`, prueba
  por `wa_factura_grupo`) tienen método por factura y **parten** en vez de retener.

**Otras retenciones:**
- `held_tpl_no_aprobada` — la plantilla de Meta no está en estado APPROVED.
- `held_multisource` — el grupo mezcla facturas LK y CH; queda para revisión humana.

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

- Edge `lk_whatsapp-webhook` (v16, `verify_jwt=false`). **Stateless**: cada mensaje cae por
  las mismas compuertas. Mapa visual: `docs/mapa-flujo-bot.html`.
- **Flujo cara-al-cliente (acordado 2026-09-04, `handleMessage` 0→6):**
  0. **Killswitch** (`wa_bot_solo_whitelist`): envuelve todo; decide si el flujo corre para ese número.
  1. **Modo humano**: si un vendedor tomó la charla (`modo=humano`), el bot no pisa; retoma al volver a `bot`.
  2. **ID por número** (`customer_phones`).
  3. **Request → FAQ** (0 tokens): bifurca cliente (`bot_response`) / no-cliente (`institutional_response`).
  4. **Sin FAQ**: cliente → agente IA (responde si puede, si no escala a humano); no-cliente → registro por CUIT.
  - "Request" = cualquier consulta/duda/pedido del cliente.
- FAQ categorías: AUTO/SEMIAUTO/IA/HUMANO. Pestaña "Preguntas frecuentes" en el front lee `wa_faq` + `wa_faq_lookup_tokens`. Escritura solo vía `lk_faq-admin` (admin). Ver regla de sincronización en `CLAUDE.md`.
- Registro por CUIT: valida módulo 11; CUIT inválido → avisa; guarda historial.
  Copy no-cliente: *"No tengo tu número registrado como cliente. ¿Me pasarías tu CUIT para verificar?"*.
- **FAQs nuevas (sql/053):** `saludo_inicial` (SEMIAUTO, activa — cliente saluda por nombre, no-cliente
  pide CUIT) y `datos_transferencia` (SEMIAUTO, **inactiva** hasta deploy — alias/CBU vienen de
  `wa_descuentos_config.pago`, editables en el Panel; lookup `payment_data` en `faq.ts`).
- **`faq.ts`**: no-cliente prioriza `institutional_response` (con fallback a `bot_response`,
  mantenido para no dejar mudas ~23 FAQs institucionales sin institucional cargado). El saludo
  lleva su propio `institutional_response` (pedir CUIT) para no saludar con nombre vacío.
- **Cables creados sin enchufar (TODO, no conectados):**
  - Escalación a humano: `notificarHumano({tipo:"escalation"})` existe pero no hay call-site que lo dispare.
  - Cierre por inactividad: bajar el vencimiento de modo humano (hoy 8h en `lk_conversaciones`) a ~30-40 min,
    avisar al vendedor / botón "Cerrar chat" en el Panel, y retomar el bot al reiniciar el cliente. Requiere idle-sweep + UI.

## ⚠️ CI de deploy ROTO — falta secret (2026-09-04)

`.github/workflows/deploy-edge-functions.yml` corre al pushear a `main`, pero **falla siempre**
porque el secret **`SUPABASE_ACCESS_TOKEN` está vacío** ("Access token not provided"). Por eso
las edge functions **no se deployan solas** y hay que hacerlo a mano (MCP `deploy_edge_function`).

**Fix permanente (lo hace el usuario):** GitHub → Settings → Secrets and variables → Actions →
agregar `SUPABASE_ACCESS_TOKEN` (generarlo en Supabase → Account → Access Tokens). Después
re-correr el workflow: deploya todo, incluido `lk_whatsapp-webhook`.

Mientras el secret no esté: cada cambio de edge function en `main` queda en el repo pero **no vivo**
hasta deploy manual.

## Edge functions que NO están en este repo (solo desplegadas)

`lk_notif-facturado` (path viejo, redirige a un número de test — en desuso), `lk_outbox-flush` (cron cada 2 min manda `wa_outbox`). Para verlas: `mcp Supabase get_edge_function`. Si las tocás, considerá traerlas al repo.

## Front

`docs/index.html`, servido por GitHub Pages desde `main`. Badge de versión abajo a la derecha (hoy `v0.16.1`). Bumpear con cada cambio de front.
