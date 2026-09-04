# ESTADO — mapa vivo del sistema

> **Leer esto (y `git log --oneline -20`) al empezar cualquier sesión.**
> **Actualizarlo al cerrar** cuando cambies flags, flujos o arquitectura.
> Última actualización: 2026-09-04.

## 🔑 Accesos, permisos y dónde está cada cosa (LEER PRIMERO)

**Qué accesos tenemos por MCP en las sesiones (no re-descubrir ni pedir tokens):**
- **Supabase** (MCP): acceso total a los 3 proyectos de la cuenta/org `azosplccoimzkdtbvzfi`
  → leer/escribir SQL, `apply_migration`, `deploy_edge_function`, logs, etc. **No hace falta pedir credenciales.**
- **GitHub** (MCP): repo `loekemeyer/GestOpClientes` → leer/commitear/pushear, Actions (disparar/ver workflows), PRs.

**Los 3 proyectos Supabase (misma cuenta):**
| Proyecto (nombre real) | ID | Qué es |
|---|---|---|
| **PaginaLK** — "loekemeyer's web" | `kwkclwhmoygunqmlegrg` | Bot WhatsApp, webhook, front (`docs/index.html`), `app_settings`, `wa_*`, edge functions `lk_*`. **Acá deploya el CI.** |
| **ISIS** — "Control Partes Talleristas" | `hrxfctzncixxqmpfhskv` | Facturación: `Facturacion_NP`, `PPP_Programacion_Diaria`, `vista_cola_impresion`, `wa_pipeline_log`, RPCs `wa_dashboard_rango`, `wa_metodo_norm`, `wa_grupos_dia_cuit`. Login Google del dashboard. |
| "Costos" | `fxyhvacysnqzzsdvmplx` | No toca el bot. |

**Tokens / secrets — dónde vive cada uno (para NO marear):**
- **Token de WhatsApp (Meta):** vive en el **secret de Edge Function** `WHATSAPP_ACCESS_TOKEN` (PaginaLK, alcance de proyecto = lo ven todas las funciones). El webhook además usa `LK_WA_TOKEN`. **NO** está en `app_settings` (la copia vieja `wa_token` se borró el 2026-09-04 porque estaba vencida y confundía). **Para chequear si el token vive y si las plantillas están APPROVED: invocar la edge `lk_tpl-check`** (no hay que pedir el token).
- **Datos de pago (alias/CBU):** `app_settings.wa_descuentos_config` → `pago.alias` / `pago.cbu`, editables desde el Panel. Los usa `lk_factura-check` y la FAQ `datos_transferencia`.
- **Lista blanca de envío:** tabla `wa_envio_contactos` (hoy: Luis, Thomy, N8N-test).
- **Llave de deploy del CI:** GitHub Actions secret `SUPABASE_ACCESS_TOKEN` (cuenta Supabase → Account → Access Tokens). Es OTRA cosa que el token de WA. Estado: ✅ **cargada el 2026-09-04, VENCE el 2027-05-04 → renovar antes** (regenerar en Supabase y re-pegar en GitHub; Supabase ya no da tokens sin vencimiento).

**Cómo se deploya una edge function:** push a `main` → CI (`.github/workflows/deploy-edge-functions.yml`) la sube. Funciones chicas también se pueden subir a mano con MCP `deploy_edge_function`. El webhook (`lk_whatsapp-webhook`, ~1500 líneas + `_shared`) es demasiado grande para transcribir a mano con fidelidad → **debe ir por CI.**

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
- **Matcher de FAQs (RPC `wa_faq_match`, reescrito sql/054 el 2026-09-04):** determinístico, 0 tokens.
  Antes era substring crudo (`LIKE '%kw%'`) sin normalizar → los acentos rompían el match, "ola"
  matcheaba "chocolate" y "?" matcheaba todo. Ahora: normaliza (unaccent + lower + `[a-z0-9 ]`),
  matchea por **inicio de palabra** (`\m`, mata falsos positivos pero tolera plurales), **dedup** de
  keywords normalizados (no doble-cuenta pares acentuados), **peso por especificidad** (frase larga
  gana a palabra suelta) y **rescate difuso** (pg_trgm `word_similarity ≥ 0.55`) para typos.
  `match_score` ahora es `numeric`: match real ≥ 1, sin match ≈ 0. `faq.ts` corta en `< 1`.
  Requiere extensión `unaccent` (creada en 054). Deploy de `faq.ts` va por CI (lo bundlea el webhook).
- **FAQ `alta_cliente` (id=6) DESACTIVADA** (sql/054): era `needs_human` y escalaba a un vendedor
  cuando el no-cliente pedía registrarse. Ahora el **intake self-service** (`wa_prospect_leads`, en el
  webhook) toma los datos paso a paso, así que esa FAQ ya no debe interceptar.
- **Backlog matcher (pulir después, 2026-09-04):** minamos `bot_historial_chat` (712 msgs de
  usuario). Conclusión: **no hay problema de typos** — las variantes (plurales/conjugaciones) ya las
  cubre el ancla `\m`; los typos reales son freq-1 e idiosincráticos (no baja el umbral difuso 0.55).
  Huecos de **vocabulario** reales a agregar (frases, NO palabras sueltas para no pisar intents):
  (1) `derivame`/`derivar`/`pasame con un humano` → FAQ contacto_vendedor (id=33);
  (2) `mis pedidos`/`que pedidos tengo`/`pedidos tengo`/`ver mis pedidos` → order_status (id=9).
  Otros a evaluar: keywords redundantes/ruidosas en `greeting_fallback` (id=40: `puedo`,`necesito`,
  `consulta`), overlap pago id=15 vs id=42, y decidir prioridad lista-genérica (id=11) vs
  precio-de-artículo (id=12) cuando el cliente nombra un producto.
- Registro por CUIT: valida módulo 11; CUIT inválido → avisa; guarda historial.
  Copy no-cliente: *"No tengo tu número registrado como cliente. ¿Me pasarías tu CUIT para verificar?"*.
- **Alta de cliente nuevo (webhook, portada de `lk_chat-test` el 2026-09-04):** cuando el
  CUIT **no está en el sistema** (`cuit_not_found`) o el no-cliente dice *registrarme / soy nuevo /
  dale*, arranca la **toma de datos paso a paso** (0 tokens, sin IA). Estado en
  `wa_prospect_leads` (`status='pending'` + `alta_step`); cada mensaje entrante es la respuesta al
  campo que toca (interceptado en `handleMessage` paso 3b, **antes** del FAQ). 13 campos base
  (razón social, contacto, tel, mail, dirección, localidad, expreso ×3, tipo/dimensión de comercio,
  venta web, ¿ya vende LK?) + 1 extra (`a_quien_compra` si ya vende / `como_conoce_marca` si no).
  Valida formato de **mail** (`x@y.z`) y **teléfonos** (≥8 dígitos) → si no cuadra, re-pregunta el
  mismo campo. *cancelar* corta el alta (`status='cancelled'`). Al terminar (`status='complete'`):
  mensaje al cliente *"La solicitud irá a revisión y nos pondremos en contacto con vos cuando sea
  aprobada!"* + **cable para el vendedor**: fila en `wa_alertas_humano` (`tipo='alta_cliente_nuevo'`)
  — **SIN enchufar** a push/notificación todavía.
- **FAQs nuevas (sql/053):** `saludo_inicial` (SEMIAUTO, activa — cliente saluda por nombre, no-cliente
  pide CUIT) y `datos_transferencia` (SEMIAUTO, **inactiva** hasta deploy — alias/CBU vienen de
  `wa_descuentos_config.pago`, editables en el Panel; lookup `payment_data` en `faq.ts`).
- **REGLA — nombres:** el bot le dice al cliente SOLO nombres de **nuestra base** (`business_name` /
  razón social). **NUNCA** el nombre de perfil de WhatsApp (`msg.name` / `contactName`) — es dato del
  usuario, no nuestro. El WA-name solo puede usarse en logs internos (`wa_alertas_humano.contexto.contact_name`)
  para el vendedor, jamás en un mensaje al cliente.
- **`faq.ts`**: no-cliente prioriza `institutional_response` (con fallback a `bot_response`,
  mantenido para no dejar mudas ~23 FAQs institucionales sin institucional cargado). El saludo
  lleva su propio `institutional_response` (pedir CUIT) para no saludar con nombre vacío.
- **Cables creados sin enchufar (TODO, no conectados):**
  - Escalación a humano: `notificarHumano({tipo:"escalation"})` existe pero no hay call-site que lo dispare.
  - Cierre por inactividad: bajar el vencimiento de modo humano (hoy 8h en `lk_conversaciones`) a ~30-40 min,
    avisar al vendedor / botón "Cerrar chat" en el Panel, y retomar el bot al reiniciar el cliente. Requiere idle-sweep + UI.

## CI de deploy — ARREGLADO (2026-09-04)

`.github/workflows/deploy-edge-functions.yml` corre al pushear a `main` y deploya las edge
functions cuyos archivos cambiaron en el commit (si cambió `_shared/`, redeploya las que lo
importan: `lk_whatsapp-webhook` y `lk_chat-test`). Antes fallaba por el secret vacío; el secret
`SUPABASE_ACCESS_TOKEN` **ya está cargado** (vence 2027-05-04, ver arriba).

**Cómo forzar un deploy:** pushear a `main` un commit que toque `supabase/functions/**`
(el detector usa `git diff HEAD^ HEAD`), o **Actions → Deploy Edge Functions → Run workflow**.
Un commit que sólo toca docs NO dispara deploy.

## Edge functions que NO están en este repo (solo desplegadas)

`lk_notif-facturado` (path viejo, redirige a un número de test — en desuso), `lk_outbox-flush` (cron cada 2 min manda `wa_outbox`). Para verlas: `mcp Supabase get_edge_function`. Si las tocás, considerá traerlas al repo.

## Front

`docs/index.html`, servido por GitHub Pages desde `main`. Badge de versión abajo a la derecha (hoy `v0.16.1`). Bumpear con cada cambio de front.
