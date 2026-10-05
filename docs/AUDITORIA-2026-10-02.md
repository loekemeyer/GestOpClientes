# Auditoría general del repo — 02/10/2026

Pedido de Pablo Olejavetzky: *"auditoría general del repo, resumen de todas las mejoras y mejorar la performance"*.
Sesión: https://claude.ai/code/session_01P5bznekJcccuV78FDbK1ih · branch `claude/happy-newton-z1ois9`.

Etiquetas: **[Seguro]** verificado en código o en la base viva · **[Probable]** inferencia fuerte de un auditor delegado, no
re-verificada línea por línea · **[Adivinando]** relleno. Lo que ya se aplicó está en la sección 2; lo demás es propuesta.
Referencias `archivo:línea` sobre `main` en `5281a20`.

---

## 1. Lo que se midió (producción, 02/10, últimas 24 h)

**Latencia por edge function** (`function_edge_logs`, `execution_time_ms`), ordenado por volumen:

| Función | Invocaciones | Promedio ms | p95 ms | Máximo ms |
|---|---:|---:|---:|---:|
| lk_conversaciones | 1.838 | 720 | 2.471 | 9.197 |
| lk_vinculaciones | 1.798 | 587 | 1.999 | 7.035 |
| lk_factura-check | 1.607 | 1.359 | 3.794 | 6.501 |
| notify-tracking-status | 1.332 | 1.176 | 2.684 | 6.857 |
| lk_alertas | 892 | 734 | 2.627 | 7.893 |
| lk_outbox-flush | 672 | 1.038 | 2.598 | 5.406 |
| lk_bot-simular | 285 | 5.259 | 13.742 | 33.143 |
| lk_ia-puntaje | 144 | 1.550 | 4.207 | 5.693 |
| lk_chat-test | 142 | 646 | 1.469 | 6.559 |
| lk_fallas-mail | 132 | 2.265 | 5.030 | 6.899 |
| lk_templates | 72 | 2.522 | 5.519 | 32.628 |
| **lk_whatsapp-webhook** | **69** | **1.246** | **4.459** | **6.629** |

- **Las dos funciones más llamadas son polling del dashboard** (`lk_conversaciones` y `lk_vinculaciones`: 3.636 de 8.900
  invocaciones del día). El bot real (webhook) fue el 0,8 %. [Seguro]
- **El webhook hacía ~30-35 viajes a la base EN FILA antes del primer token del modelo** (contados sobre el código:
  loadConfig 3-4, candados 5, cliente 2, ráfaga 2-4, aviso 1, pedido-archivo 2, pedido en curso 1-2, marca 0-3, FAQ 1,
  historial 1, prompt 4, herramientas 2, cadena 2). Las tablas son chicas (ver abajo): el costo es el ida y vuelta, no la
  consulta. [Seguro]
- **Base:** `app_settings` 40 filas / 8 KB · `wa_conversations` 304 · `bot_historial_chat` 1.621 · `wa_outbox` 109 ·
  `bot_token_usage` 654 · `wa_inbound_seen` 1.359 · `wa_message_status` 6.339 (5,1 MB) · `wa_alertas_humano` 830 ·
  `wa_faq` 31 · `wa_envio_contactos` 1. Ninguna tabla del bot pesa nada todavía. [Seguro]
- **Lo que sí pesa en la base no es del bot:** `net._http_response` 55 MB para 378 filas vivas (el DELETE de limpieza de
  pg_net lleva 239.464 ejecuciones a 752 ms de promedio = **50 horas de CPU** acumuladas, la consulta más cara del
  proyecto) y `cron.job_run_details` 168 MB. Son bloat: tabla hinchada que el autovacuum no achica. [Seguro]
- `pg_stat_statements`, top 5 por tiempo total: el DELETE de pg_net (50 h), `sync_pedidos_match_virgilio` (8,1 h, 6,4 s
  por corrida), `sync_reingresos_virgilio` (7,8 h, 9,6 s), `sincronizar_chef_orders` (6,5 h, 8,7 s), `gv_watch_gestion_tick`
  (3,6 h, cada minuto). Todo de Gestión/Virgilio, no de este repo. [Seguro]

---

## 2. Lo que se aplicó hoy (performance, sin cambio de comportamiento)

Todo pusheado en `claude/happy-newton-z1ois9`. Se deploya recién al mergear a `main` (CI). `deno check` de los tres
entrypoints que importan lo tocado (webhook, simulador, chat de prueba) da **exactamente los mismos 8 / 8 / 16 errores
previos** que `main`: cero errores nuevos. `deno lint` idéntico a `main` (7 avisos preexistentes).

1. **Caché de `app_settings` en el webhook** (`_shared/supabase.ts`: `habilitarCacheSettings`, `primeSettings`,
   `cacheSettingsTtl`). Un solo viaje trae la tabla entera (40 filas) y las ~17 lecturas de `getSetting` por mensaje salen
   de memoria durante 15 s. **Opt-in**: sólo `lk_whatsapp-webhook/index.ts` la prende; Simulador, chat de prueba y
   dashboard siguen leyendo en vivo. La llave `wa_envio_automatico` no pasa por acá (la lee `wa_puede_enviar` en SQL
   desde wa-guard, sin caché): el principio "vasectomía" queda intacto.
2. **Candados del webhook en paralelo** (`lk_whatsapp-webhook/index.ts`, `handleMessage`): llave de whitelist, whitelist,
   blacklist y cliente se leen juntos (eran 4 viajes en fila) y se evalúan en el mismo orden. El modo de la conversación
   queda afuera a propósito: `bot_conv_get_modo` hace un UPDATE (vence el modo humano) y no debe correr para un número
   descartado (lo marcó la revisión adversarial previa al merge). `avisarDescartePorWhitelist` recibe el cliente ya
   identificado en vez de volver a buscarlo.
3. **`first_seen` reutilizado**: el insert del candado de idempotencia (`wa_inbound_seen`) devuelve `first_seen` y
   `handleMessage` lo recibe; el saludo suelto y la ráfaga de pedido ya no lo vuelven a leer (1-2 viajes menos).
   `pedidoEnCurso` se consulta una sola vez por mensaje (antes, dos).
4. **Arranque del agente en paralelo** (`_shared/bot-conversation.ts`, `runConversation`): historial, system prompt,
   herramientas y cadena de modelos juntos (eran ~9 viajes en fila). Dentro de `buildSystemPrompt`: documento rector,
   config de pedidos y mínimo del cliente en paralelo. `herramientasDelTurno`: config de pedidos y derivaciones en paralelo.
5. **`wa_pedidos_cfg` memoizado** el mismo tiempo que la caché de settings (se leía hasta 6 veces por mensaje). Sólo se
   memoiza una lectura real: si el RPC falla se devuelve el default sin guardarlo (la revisión adversarial encontró que la
   primera versión memoizaba 15 s el default de falla). Sin caché prendida (Simulador) va a la base cada vez, como antes.
6. **Lecturas de `wa_descuentos_config` y `wa_minimo_compra` por `getSetting`** en `faq.ts`, `respuesta-aviso.ts` y
   `minimo.ts` (eran selects directos que no aprovechaban la caché). En `lookupCustomerDiscount` las 4 lecturas (2 van a
   Gestión, lo lento) van juntas; en `responderRecordatorio` los días hábiles se piden todos juntos; `minimoCliente` lee
   general y excepción juntos.
7. **Guardar la respuesta y encolar el puntaje de la IA** van juntos al final del turno (antes, en fila), y el insert del
   puntaje ahora loguea el error de la base (PostgrestBuilder no lanza: antes el `catch` nunca corría).
8. **sql/122 — índices** (6 aplicados en producción, verificado en `pg_indexes`):
   `wa_inbound_seen (phone, first_seen desc)` · `wa_alertas_humano (phone, created_at desc)` ·
   `wa_alertas_humano (created_at) where estado in ('pendiente','notificado')` · `wa_outbox (context, ref_id)` ·
   `wa_clientes_telefono (right(wa_normalize_phone(telefono),10))` — la expresión que `wa_identify_customer` usa de verdad
   desde sql/073; el índice de sql/010 tiene **0 usos** en todo su historial · `bot_token_usage (model, created_at desc)`.
9. **Dashboard v0.26.11**: con la pestaña del navegador oculta no se pollea (`document.hidden`) y al volver se refresca en
   el acto (`docs/gestop2.js` tick de 45 s; `docs/index.html` contador de alertas de 120 s). Lo único que cambia es que una
   pestaña que nadie mira deja de gastar 270-350 invocaciones por hora. Versión visible: **v0.26.11**.

**Estimación del efecto en el webhook** [Probable]: de ~30-35 viajes en fila a ~12-15 antes del modelo. A 40-80 ms por
viaje son 0,7-1,5 s menos por mensaje sobre un promedio de 1,25 s (el resto es Meta y el modelo). Se mide después del
deploy con la misma consulta de `function_edge_logs` de la sección 1.

---

## 3. Hallazgos por gravedad (lo que NO se tocó)

### 3.1 Seguridad

1. **`lk_factura-check` no tiene ningún gate** (`lk_factura-check/index.ts:701`, `serve` sin `requireAdmin` ni
   `x-lk-secret`; CORS `*`). Cualquiera con la URL dispara envíos al número de redirección, reclama grupos en
   `wa_grupo_listo` (un claim falso deja el grupo "enviado" y el aviso real no sale) y escribe `wa_shadow_log` /
   `wa_sim_inbox`. **Alto.** [Seguro]
   **EN CURSO (05/10).** Los llamadores son TRES, no dos (el tercero no estaba en el informe): el trigger
   `wa_factura_notificar` (Gestión, sobre `isis_lk.documentos` e `isis_ch.documentos`), el cron `wa_barrido_avisos` de Gestión
   (jobid 69, cada 15 min) y `lk_notif-sim`; ninguno mandaba header. Y `handleGrupo` (`mode:"grupo"`) no tiene llamador conocido
   en el repo: si existe uno externo (n8n, por ejemplo) sólo aparece en los logs del modo `log`.
   Diseño: secreto aleatorio en el Vault de GESTIÓN (`lk_factura_check_secret`, no se copia ni se muestra); la edge lo lee con
   `wa_factura_check_secret()` (sólo service_role). Llave `app_settings.wa_factura_check_gate` en tres escalones: sin fila =
   apagado · `log` = registra lo que no trae secreto válido y lo deja pasar · `1` = 401 (falla cerrada). Código en `main`
   con la llave apagada (sin efecto, deploy verde); SQL de Gestión en `sql/isis_wa_factura_check_gate.sql`, **aplicado el 05/10**.
   Pasos: código (hecho) → SQL de Gestión (hecho) → llave en `log` un día → llave en `1`. Pruebas: `tests/gate-factura-check.test.ts`.
2. **XSS en el chat de prueba del dashboard**: `docs/index.html:1973` `div.innerHTML = text.replace(/\n/g,"<br>")` con la
   respuesta del modelo / de la FAQ. Un prompt injection que devuelva `<img onerror=…>` corre en la sesión de un admin
   logueado con Google. **Corregido el 02/10 (v0.26.12)**: `esc(text)` antes del replace. [Seguro]
3. **`esc()` no escapa comillas** (`docs/index.html:3975`, sólo `& < >`) y se usa dentro de atributos y `onclick` en 15
   lugares; `gesc` de gestop2.js delega en ella, así que su rama segura está muerta. **Corregido el 02/10 (v0.26.12)**:
   escapa también `"` y `'`. [Seguro]
4. **Lecturas públicas con la clave publishable** (RLS `using (true)` para `anon`): `gestop_users (email, role)` — la lista
   de mails del staff y quién es admin se enumera con un `GET /rest/v1/gestop_users?select=email,role` (sql/063:28-34);
   `wa_agente_config.contenido` (el prompt del agente, sql/058:67), `wa_agente_config_history`, `wa_agente_modelos`
   (`key_last4`, `secret_ref`). `wa_agente_evals` ya se cerró en sql/118: falta hacer lo mismo con estas 4. **Alto.** [Seguro]
5. **Simulador con estado global compartido** (`_shared/simulacion.ts` `SIM`; `lk_bot-simular/index.ts:69,144,263` lo
   prende y lo apaga en `finally`). Si dos simulaciones corren a la vez en el mismo isolate, cuando termina la primera
   apaga `SIM.activo` y **la segunda sigue con escrituras reales** (alertas, historial, herramientas con efecto). Fix
   barato: rechazar con 409 el segundo request mientras `SIM.activo`. **Alto.** [Probable: el runtime de Supabase atiende
   requests concurrentes por isolate; no se reprodujo]
6. **`lk_outbox-flush` ignora el request** (`Deno.serve(async () => …)`, `lk_outbox-flush/index.ts:42`): cualquiera dispara
   el flush. Los envíos quedan detrás de la llave, pero es el mismo agujero que `notify-tracking-status` cerró el 12/09.
   **Medio.** [Seguro]
7. **Funciones `SECURITY DEFINER` posteriores a sql/056 sin `REVOKE … FROM anon`** (0 revokes en todo `sql/` después de
   056): `wa_avisos_retiro_web`, `wa_avisos_preparando_web`, `wa_avisos_en_viaje_web` insertan en `wa_outbox` y disparan el
   flush; `bot_cliente_por_whatsapp` devuelve `customer_id`, `cod_cliente`, razón social y `dto_vol` de un teléfono (enumerable);
   `wa_fecha_estimada_calc`; en ISIS las `wa_sim_*` (una inserta en `isis_lk.documentos` y dispara el trigger real).
   Fix: una línea de `revoke` por función; las edges usan service_role. **Medio.** [Probable: default de Postgres;
   falta confirmar en vivo con `has_function_privilege('anon', …)`]
8. **4 teléfonos reales de clientes en el HTML público** (`docs/index.html:1433 KNOWN_PHONES`), servidos antes del
   login. Contradice "único canal de prueba: Thomy". **Corregido el 02/10 (v0.26.12)**: el chat de prueba toma el
   teléfono de la whitelist (`wa_envio_contactos`) vía `lk_chat-test whitelist_list`; sin whitelist, avisa. [Seguro]
9. **Comparación de secretos con `===`** (no constant-time) en 12 funciones (`lk_alerta-planify:40`, `lk_ia-puntaje:39`,
   `lk_templates:38`, `lk_alertas:81`, `notify-tracking-status:211`, …). `admin-gate.ts:153` y `webhook-firma.ts:51` sí lo
   hacen bien. **Bajo**, gratis con un helper compartido. [Probable]
10. **Código muerto que viaja con el service_role**: `inbox-register/index.ts:74-94 resumeConversation` POSTea a
    `/functions/v1/whatsapp-webhook` (función que no existe) mandando la service_role como header. Siempre 404. **Bajo.**
    [Probable]
11. `inbox-api/index.ts:159` devuelve `token: INBOX_PASSWORD` en el login. **Bajo.** [Probable]
12. **Lo que está bien**: 0 salidas a Meta sin `wa-guard` (las 9 funciones que postean a `/messages` lo importan); 0
    claves legacy (`eyJhbGci…`) en el repo; 0 escrituras directas a tablas desde el dashboard (todo por edge con
    `requireAdmin`, `wa_faq` por `lk_faq-admin`); 0 inyecciones por string (el único `.or()` armado a mano pasa por
    `cuitNorm`); firma de Meta verificada en tiempo constante; los dos respaldos de `wa_faq` en `public` **sí** tienen RLS
    (el auditor SQL dijo lo contrario leyendo el repo; en la base viva están cerrados). [Seguro]

### 3.2 Performance (lo que queda)

1. **`lk_parse-comprobante` llama a Anthropic y a Gemini y no registra en `bot_token_usage`** (0 ocurrencias en el
   archivo). Rompe la regla de gasto del 01/10: ese costo no aparece en ningún tablero. **Alto por la regla**, fix de 10
   líneas (ya calcula `input_tokens`/`output_tokens` en :224 y :267). [Seguro]
2. **Polling del dashboard**: 45 s (`gestop2.js`) × 3-4 edges por tick + 120 s (`index.html`) = 270-350 invocaciones
   por hora por pestaña abierta mirando. Hoy se pausa con la pestaña oculta (punto 2.9); bajar a 120 s y deduplicar
   `lk_alertas list` (lo llaman dos pollers distintos) lo deja en ~90-120. Cambia la latencia de los badges: decisión de Pablo.
3. **Carga inicial del dashboard**: 7 llamadas (2 PostgREST + 5 edge). `gestop_users` se lee 2 veces (`index.html:1456`
   `role`, `gestop2.js:586` `username`); `refreshCosts` (`index.html:1495, 2050`) pinta un `<div hidden>` con una llamada
   de red al login y después de cada mensaje de prueba; `loadConfigPage` (i:2127) y `loadAgentePage` (i:2548) hacen 3 y 2
   saltos donde alcanza 1. [Probable]
4. **`lk_factura-check` lee `app_settings` 8-12 veces por invocación** (`wa_descuentos_config` ×2, `wa_plantilla_formato`
   ×2, versiones ×2 por subgrupo, redirect ×2) y **combina y sube el PDF antes de saber si el estado es `held_*`**
   (`:584-591`, `:661-668`, `:788-795`): trabajo tirado cuando no se manda. 1.607 invocaciones/día a 1,36 s. [Probable]
5. **`wa_fecha_estimada_calc` dentro del trigger de `orders`** (sql/082:75-95, `after insert or update of sheets_sent`):
   calcula `percentile_cont` sobre 90 días de `orders × order_tracking × v_pedidos_web` en cada confirmación de pedido
   web, y lo repite si `n < 20`. Cachear el p90 por modo en una tabla chica refrescada por cron. [Probable]
6. **`wa_pedido_parecidos`** (sql/112:86-88) llama a la FDW de Gestión **una vez por pedido** cuando la línea anterior ya
   trajo todos los ids: N+1 contra Gestión en cada precarga. [Probable]
7. **`pedido-archivo.ts:156-165`**: por cada línea del Excel (hasta 120) un query a `products` + hasta 5 RPC. Peor caso
   ≈ 840 viajes. Un `.in("cod", todos)` antes del loop. [Probable]
8. **Cuatro módulos leen las últimas filas de `bot_historial_chat` por separado en el mismo mensaje** (`avisoReciente`,
   `pedidoEnCurso`, `ultimoMensajeBot`, `filasRecientes` de marca, más `loadHistory`): una sola lectura de las últimas 16
   filas compartida ahorraría 3-4 viajes más. Toca 4 módulos con ramas `SIM`: no se hizo hoy a propósito. [Seguro]
9. **Sin `.limit()` donde PostgREST corta en 1.000 en silencio**: `pedidos-anulados.ts:23-24` (`GV_Pedidos_Anulados`: si
   pasa de 1.000, los anulados nuevos quedan afuera y el bot los muestra), `lk_recordatorio-descuento:82,114`,
   `lk_alertas:251` (1.000 global para N teléfonos). Correctitud silenciosa, no sólo performance. [Probable]
10. **Sin timeout en el fetch saliente**: `lk_templates` (15 fetch), `_shared/wa-api.ts` (3, incluido
    `downloadMediaFromMeta`), `notify-tracking-status`, `lk_outbox-flush`, `lk_faq-admin:70` (la misma llamada a GoTrue
    que colgó el dashboard 90 s el 28/09 y que admin-gate arregló con 6 s: la copia no tiene el fix). [Probable]
11. **Bloat fuera del bot**: `net._http_response` (55 MB / 378 filas) y `cron.job_run_details` (168 MB). `VACUUM FULL`
    bloquea la tabla unos segundos; `job_run_details` además necesita retención (pg_cron no la borra sola). [Seguro]
12. **Dos índices redundantes que no se pudieron borrar hoy** (el MCP retiene los `DROP` esperando confirmación):
    `idx_wa_clientes_telefono_norm` (0 usos) y `bot_token_usage_created_at` (duplicado exacto de `idx_bot_token_usage_created`).
    SQL en la sección 4. [Seguro]
13. Advisors de Supabase (performance, 621 hallazgos en todo el proyecto, 106 de tablas del bot): 17 policies del bot que
    re-evalúan `auth.<fn>()` por fila (`auth_rls_initplan`: envolver en `(select auth.role())`), 6 FKs sin índice en tablas
    del bot (`wa_order_draft.customer_id`, `wa_pedido_precarga.order_id`, `wa_agente_modelos.key_id`,
    `wa_comprobantes.parse_model_id`, `bot_chef_whatsapps.request_id`, `bot_registration_requests.customer_id`). Impacto
    bajo con los volúmenes de hoy. [Seguro: salida del advisor]

### 3.3 Robustez

1. **Fetch a Meta sin `try/catch` dentro de loops**: `lk_outbox-flush:28-33` (un error de red o un body no-JSON tira la
   función con 500 y el resto del batch queda como lo dejó `bot_flush_outbox`), `notify-tracking-status:139-153,170-188`
   (corta el loop de 50), `asoc-timeout-cron:45-60` (la fila ya se marcó `timeout_to_inbox` antes de mandar: un throw deja
   filas marcadas sin aviso). [Probable]
2. **Promesas que tragan errores de la base**: `pedido-archivo.ts:86-89,139-140`, `transcribir.ts:112-115`,
   `lk_ia-puntaje:77-80`, `lk_chat-test:150,161,222`, `lk_templates:248-250` hacen `.catch` sobre un PostgrestBuilder, que
   **no rechaza** en error: un insert fallido en `bot_token_usage` se pierde sin log. El tablero de gasto no es confiable
   al 100 %. [Probable] (El mismo patrón estaba en el webhook, punto 2.7: corregido.)
3. **Dos fuentes de verdad para la urgencia**: `alertas.ts:13 MOTIVOS_URGENTES` tiene `anulacion_pedido`;
   `alertas-vencimiento.ts:82 CATEGORIAS_URGENTES` tiene `cambio_pedido`. La misma alerta sale 🔴 o 🟡 según quién la calcule.
   Hay que elegir una antes de unificar. [Probable]
4. **El chat de prueba reimplementa el alta** (`lk_chat-test:557-717`, 13 pasos) distinto de `_shared/alta.ts` (11) y con el
   `maybeSingle()` sobre leads pending que alta.ts arregló en v14.13: el test no prueba lo que corre en producción. [Probable]
5. **Listas de plantillas a mano desactualizadas**: `lk_tpl-check:19-25` y `lk_fallas-mail:51-62` incluyen `pedido_preparando`
   (quitada el 29/09) y les faltan `pedido_recibido`, `pedido_entregado`, `pedido_recordatorio_descuento`. Derivarlas de
   `PLANTILLAS` + `PLANTILLAS_FACTURA`. [Probable]
6. **Clave de Anthropic con dos nombres**: `lk_ia-puntaje:107` lee `ANTHROPIC_API_KEY` (settings primero); `lk_bot-simular:244`
   y `lk_chat-test:171` leen `anthropic_api_key` (env primero). [Probable]
7. **Cron `wa_outbox_flush` de sql/005** postea `{"action":"flush"}` al webhook, acción retirada el 10/09. El cron vivo
   (`jobid 21`) ya apunta a `lk_outbox-flush`, así que el de 005 es historia muerta en el repo, no un job roto. [Seguro: lista
   de `cron.job` del 02/10]
8. **El CI no redeployaba los imports de efecto de `_shared`** (`.github/workflows/deploy-edge-functions.yml:93`): el grep
   buscaba `from "../_shared`, y `asoc-timeout-cron`, `inbox-api`, `inbox-register`, `notify-order-created` y
   `notify-tracking-status` importan `wa-guard.ts` SÓLO como `import "../_shared/wa-guard.ts";`. Un cambio en el corte
   único de envíos a Meta no las habría redeployado: cinco salidas con el guard viejo. Visto en el deploy de hoy (14
   funciones redeployadas, esas 5 no). **Corregido** en el mismo día: el grep ahora busca `"../_shared/`. [Seguro]

### 3.4 Datos y retención

**9 tablas crecen sin poda y 0 crons las limpian**: `wa_conversations` (por mensaje), `bot_token_usage` (por llamada al
modelo), `wa_outbox` (`sent`/`failed` nunca se borran; ojo: la deduplicación por `context/ref_id` depende del histórico,
mínimo 60 días), `wa_message_status` (3-4 estados por mensaje saliente, la que más crece: 6.339 filas), `wa_inbound_seen`
(`wa_inbound_seen_limpiar(7)` existe desde sql/057 y nunca se agendó), `wa_alertas_humano` (633 filas de `whitelist_gate` en
8 días con texto de no-clientes), `wa_ia_puntajes`, `bot_historial_chat`, `wa_pipeline_log` (ISIS). Hoy no pesan; la
decisión es cuántos días guardar de cada una (sección 5). [Seguro: inventario de `cron.job` del 02/10]

### 3.5 Deuda y mantenibilidad

1. **Las migraciones del repo no definen el esquema**: 27 tablas/vistas que el bot usa en caliente no se crean en ningún
   `sql/*.sql` (`app_settings`, `bot_customer_whatsapps`, `bot_token_usage`, `order_tracking`, `bot_historial_chat`, `customers`,
   `orders`, `products`, …), ni las columnas `wa_outbox.context/ref_id` que 12 sitios usan desde sql/070, ni el schema
   `zz_backups`. Un re-apply limpio falla en 070. Son de PaginaLK/Gestión: documentarlo en `docs/ESTADO.md` alcanza. [Seguro]
2. **65 sentencias en 24 migraciones no son idempotentes**: 24 `create index` sin `if not exists`, 14 `create policy` sin
   `drop … if exists`, 7 `create trigger`, 6 seeds `insert` sin guarda (re-correr sql/007 **duplica las 40 FAQ en silencio** y
   `wa_faq_match` empieza a elegir duplicados), 11 parches por texto que fallan en la segunda corrida. [Probable]
3. **Numeración**: falta 019; tres pares duplicados (033, 061, 062). [Seguro]
4. **Duplicación en edge functions**: 16 `createClient` fuera de `_shared/supabase.ts`; 6 copias de `getSetting`; 8 copias de
   `esLlamadaInterna`; 9 formas de "hoy en Argentina"; 8 de formatear pesos; 4 variantes de canonicalizar teléfono (con
   semánticas distintas: `normalizeAR` de `lk_notif-sim:81` usa prefijo 549); 2 gates admin (`admin-gate.ts` y la copia de
   `lk_faq-admin` sin timeout ni caché). [Probable]
5. **Código muerto**: `_shared/claude.ts` (156 líneas, 0 importadores); `flushOutbox` en el webhook (`:345`, 0 llamadas; el
   flush vivo es `lk_outbox-flush`); ≈530 líneas del dashboard (composer de plantillas i:3958-4074 con `sendTemplateTest`,
   un emisor de WhatsApp latente; simulador de avisos i:4075-4286; pestaña legacy "Conversaciones reales" i:573-620 +
   4301-4451; menú viejo `<div hidden>` i:409-429 + `refreshCosts`); tablas `customer_phones` y `wa_order_draft` (0
   referencias en edge) con su cron `wa_expire_drafts`; módulo `wa_question_*` (3 tablas, función sin llamadas);
   `bot_pedido_*` (3 tablas, detector sin cron). [Seguro para claude.ts y flushOutbox; Probable el resto]
6. **Dashboard**: tres versiones distintas en el mismo archivo (badge, `gestop2.js?v=`, `gestop2.css?v=0.25.17`; hoy se
   alinearon badge y js en 0.26.11, el css sigue en 0.25.17 porque no cambió); supabase-js desde CDN con major flotante
   `@2`, síncrono en `<head>`, sin `integrity`; 129 `onclick=` inline (sin CSP posible); 8 escapers con 4 comportamientos;
   runtime mezclado en las edges (16 con `serve` de std 0.177 deprecado, 7 con `Deno.serve`). [Probable]

---

## 4. SQL listo para correr cuando Pablo diga "sí"

```sql
-- (a) los dos índices redundantes que el MCP no dejó borrar hoy (sql/122). Sin efecto funcional.
drop index if exists public.idx_wa_clientes_telefono_norm;     -- 0 usos; wa_identify_customer usa right(...,10) desde sql/073
drop index if exists public.bot_token_usage_created_at;        -- duplicado exacto de idx_bot_token_usage_created

-- (b) poda de wa_inbound_seen: la función existe desde sql/057, nunca se agendó. Borra candados de más de 7 días
--     (Meta reintenta en minutos; la ráfaga mira 6 s). Efecto en cadena: ninguno.
select cron.schedule('wa_inbound_seen_limpiar', '15 4 * * *', $$select public.wa_inbound_seen_limpiar(7)$$);

-- (c) bloat fuera del bot. VACUUM FULL toma lock exclusivo unos segundos: hacerlo en horario sin movimiento.
vacuum full net._http_response;        -- 55 MB → ~1 MB
delete from cron.job_run_details where end_time < now() - interval '14 days';   -- 168 MB; después vacuum full
```

---

## 5. Decisiones pendientes (por impacto)

1. **¿Pusheo a `main`?** Lo de la sección 2 está en la branch y se deploya recién al mergear (CI). Toca `_shared/supabase.ts`,
   así que el CI redeploya todas las funciones que importan `_shared` (~20); el cambio es opt-in y no cambia nada en las
   que no lo prenden. Si sí, después de 24 h se repite la medición de la sección 1 para confirmar el efecto.
2. **Las tres correcciones de seguridad del dashboard de una línea** (3.1.2, 3.1.3, 3.1.8) y **cerrar la lectura anon de
   `gestop_users` / `wa_agente_config`** (3.1.4): ¿van en la próxima tanda o se aceptan como están?
3. **Retención** (3.4): cuántos días guardar `wa_conversations`, `wa_message_status`, `bot_token_usage`, `wa_inbound_seen`
   y las alertas `whitelist_gate`, y si se borra o se archiva a `zz_backups`. Con eso se escriben los crons.
