# Pendientes de la auditoría del bot — 2026-09-07

> **Leé esto y `docs/ESTADO.md` antes de tocar el bot.** Sale de una auditoría de 5 revisiones
> en paralelo (flujo conversacional, FAQs, seguridad, repo↔base, dashboard/docs) hecha el
> 2026-09-07. Todo lo de acá está **verificado en el código o en la base**, no es especulación.
>
> Lo que ya se arregló está en la sección 0 — **no lo re-hagas**. Lo que falta va priorizado.
> Cuando cierres un punto, borralo de acá y anotalo en `ESTADO.md`.

---

## 0. Ya hecho y desplegado (no re-hacer)

Mergeado a `main` en `2360241`; CI deployó las 6 functions (webhook v24, chat-test v26,
notif-sim v18, templates v10, conversaciones v9, agente-modelos v9) y el dashboard quedó en
**v0.16.4**.

- **Gate de admin** (`_shared/admin-gate.ts`, patrón `lk_faq-admin`) en `lk_chat-test`,
  `lk_notif-sim`, `lk_templates`, `lk_conversaciones` y `lk_agente-modelos`. Eran endpoints
  HTTP anónimos (el CI deploya con `--no-verify-jwt`). Ningún cron las llama — verificado en
  `cron.job`. El front pasa por el helper `authedInvoke()`.
- **Auto-vinculación eliminada** de `lk_chat-test`: hacía `upsert` a `bot_customer_whatsapps`
  con `is_primary:true` desde un `cod_cliente` (enteros secuenciales) → takeover de cuenta
  enumerable.
- **`sql/056_seguridad_rls_revokes.sql`** (aplicada): RLS + grants cerrados en 10 tablas,
  `EXECUTE` revocado a `anon` en 18 funciones (entre ellas `bot_submit_order`), y la policy de
  `product_aliases` que se llamaba `service_role_all` sin restringir rol. Rollback en la
  cabecera del archivo.
- **Identificación de clientes**: el webhook resolvía sólo por `bot_cliente_por_whatsapp`
  (`bot_customer_whatsapps`, **0 filas**) → nadie era cliente y todo caía a la rama de
  no-cliente. Ahora cascada `wa_identify_customer` → `bot_cliente_por_whatsapp`. Cobertura
  medida: **547 de 610 teléfonos, 0 ambiguos** (los 63 restantes son fijos).
- **Model id**: `claude-sonnet-4-6-20250514` no existe (`20250514` es el snapshot de Sonnet 4)
  → 404 → silencio al cliente. Queda `claude-sonnet-4-6`.
- **Historial**: podía arrancar con `assistant` → 400 → silencio; y el turno actual iba
  duplicado. Se recorta hasta el primer `user` y se deduplica.
- **Descuento por volumen**: `faq.ts` leía `customers.discount`, columna inexistente →
  "Por volumen: 0%" a los 561 clientes que sí tienen descuento. Ahora `dto_vol × 100`.

**Sin verificar en vivo** (el contenedor de la sesión no alcanza `*.supabase.co`): que el gate
rechace una llamada anónima, y que el bot conteste un mensaje real. No hubo tráfico al webhook
entre el deploy y el cierre de la sesión.

### 0.b — Segunda tanda (2026-09-07, tarde)

Cierra los puntos **5**, **7** y **9**, y la nota suelta del punto 8 sobre `anonKey`.

- **Firma de Meta (`X-Hub-Signature-256`)** — `_shared/webhook-firma.ts`, usado por el POST del
  webhook. Se lee el cuerpo **crudo** (`req.text()`) porque el HMAC es del texto exacto que
  llegó; parsear y re-serializar lo rompería. Comparación en **tiempo constante**.
  **Arranca en dos pasos a propósito**: sin `META_APP_SECRET` cargado no rechaza nada, sólo
  avisa por consola. Prenderlo de golpe sin el secreto dejaría al bot mudo para todos.
  **Falta el paso 2, del dueño:** Meta → App → Settings → Basic → App Secret, cargarlo como
  secret de la edge function con nombre `META_APP_SECRET`. Ahí queda cerrado de verdad.
- **Acciones internas separadas de Meta.** `{"action":"flush"}` no lleva firma de Meta (no
  viene de Meta), así que se autentica aparte con `LK_INTERNAL_SECRET` (header
  `x-lk-internal-secret` o campo `secret`), con el mismo arranque en dos pasos. Hoy ningún cron
  la llama —el flush del outbox lo hace `lk_outbox-flush`, job 21— así que cargar ese secreto
  no rompe nada.
- **Idempotencia por `wamid`** — `sql/057_wa_inbound_idempotencia.sql`, aplicada. Tabla
  `wa_inbound_seen` (PK `wamid`, RLS prendida y **sin policies**: sólo `service_role`). El
  webhook intenta insertar el `wamid` **antes** de procesar; si choca (23505) es un reintento
  de Meta y devuelve 200 sin hacer nada. Si el insert falla por cualquier otro motivo, **el
  mensaje se procesa igual**: es preferible contestar dos veces a no contestar. Función de
  limpieza `wa_inbound_seen_limpiar(dias)` (default 7), sin cron todavía.
- **`lk_parse-comprobante` con candado** — `requireAdminOrService` (nuevo en
  `_shared/admin-gate.ts`). Acepta el dashboard (admin) **o** una llamada interna con el
  service_role como Bearer, que es como lo dispara `triggerParser` del webhook. Sin esto era
  OCR gratis contra nuestras claves, y el fallback manda el comprobante al free tier de Gemini.
- **`anonKey` renombrada a `serviceKey`** en `triggerParser`: era el service role, no la anon
  key, y el nombre engañaba (nota del punto 8).

### 0.c — Tercera tanda (2026-09-07, tarde): las tablas del agente

Cierra el punto **3**.

- **`sql/058_wa_agente_rls.sql`** (aplicada). RLS prendida en las cinco `wa_agente_*` y a `anon`
  le queda **sólo SELECT**, y sólo en las cuatro que no tienen datos de cliente (config,
  historial, evals, modelos). **`wa_agente_consultas` no**: son preguntas de clientes reales, y
  ahí ni la lectura sale con la anon key.
- **Las escrituras se mudaron a `lk_agente-modelos`**, que ya exigía admin: acciones
  `config_save`, `consultas_list`, `consulta_responder`, `consulta_descartar`, `eval_add`,
  `eval_save`, `eval_delete`, `modelos_prioridad`. El front las llama con el helper `agente()`
  (mismo patrón que `chatTest()`), 10 call sites cambiados. Dashboard **v0.16.5**.
- **De paso, un bug**: `writePrioridades` hacía un UPDATE por fila desde el navegador; si se
  cortaba a la mitad la cadena de modelos quedaba rota. Ahora es una sola llamada que limpia las
  prioridades viejas y numera 1..N del lado del servidor.

**Medido después de aplicar**, haciéndose pasar por `anon`: lee config (1), historial (1),
evals (6) y modelos (42); `wa_agente_consultas` da `42501 permission denied`; los grants de
`anon` quedaron en `SELECT` y nada más en las cuatro tablas.

**Ojo con el orden**: el SQL y el deploy del front van juntos. Aplicar el SQL con el front
viejo deja los botones de guardar muertos.

**Lo que sigue abierto del punto 4** (el módulo es decorativo): `_shared/agente.ts` sigue sin
importarse desde ningún lado, así que el prompt que edita el panel **todavía no es el que usa el
bot**. Ahora sí se puede enchufar sin abrir un agujero —esa era la condición—, pero cambia lo
que el bot le dice a los clientes, así que es una decisión del dueño, no un fix de seguridad.

---

**Verificación:** `tsc --strict --noResolve` limpio sobre los cuatro archivos tocados (los
errores que quedan en `lk_parse-comprobante` son previos, líneas 130-152). **Ojo con el
chequeo: sin `--strict` TypeScript no estrecha uniones discriminadas y da falsos positivos en
`gate.error` / `firma.motivo`.** Deno corre en strict. Sigue sin poder probarse en vivo: el
contenedor no alcanza `*.supabase.co`.

---

## 1. Crítico — del dueño, nadie más puede

1. **Rotar `LK_WA_TOKEN` y `isis_supabase_service_key`.** `app_settings` tiene la policy
   `app_settings_select_all` (SELECT, roles `{anon,authenticated}`, `USING (true)`) y la anon
   key es pública (va en `docs/index.html`, servido por GitHub Pages). Hoy cualquiera lee el
   token de Meta de producción y el **service_role del proyecto ISIS**
   (`hrxfctzncixxqmpfhskv` → RW total sobre facturación y producción, salteando RLS).
   Pasos: generar los nuevos → cargarlos como Edge Function secrets → borrar las filas de
   `app_settings` → acotar la policy a una whitelist de keys no sensibles.
   *(La policy no se tocó a propósito: cerrarla antes de rotar rompe lecturas todavía sin mapear.)*
2. **Borrar `lk_wh_stage`** (dashboard → Edge Functions → Delete; no hay tool MCP). Es un
   **segundo webhook completo**, público, sin JWT, **no versionado en el repo**, con lógica
   vieja (umbral FAQ 0.3 contra el 1 del repo, sin blindaje anti-jailbreak, sin alta paso a
   paso). Puede mandar WhatsApp, correr las tools sobre datos de clientes y flushear el outbox.
   **0 invocaciones en 24 h.** Decidir también qué se hace con la legacy `whatsapp-webhook`
   v153, también ACTIVE, sin JWT, con 0 invocaciones y sin mención en ningún doc.

---

## 2. Seguridad que queda abierta

4. **El módulo "Configuración del agente" es decorativo.** `_shared/agente.ts`
   (`getAgenteConfig`, `buildAgenteSystem`, `logAgenteConsulta`) **no lo importa nadie**; el
   system prompt real está hardcodeado en `_shared/bot-conversation.ts:183-218`
   (`buildSystemPrompt`). Editás el prompt en el panel y el bot sigue con el viejo, sin aviso.
   `docs/AGENTE.md:8-12` afirma lo contrario. `logAgenteConsulta` tampoco tiene call-site, así
   que el agente nunca levanta dudas solo.
   *Fix*: armar el prompt con `buildAgenteSystem()` en `runConversation` (concatenando el
   bloque de Seguridad) — o borrar `agente.ts` y decir en el doc que el prompt es hardcodeado.
   **Ojo: enchufarlo con el punto 3 abierto convierte el agujero en prompt injection persistida.**
6. **`gestop_users.password_hash` legible por `anon`** (policy `anon_read`, SELECT, `USING
   (true)`). Son SHA-256 **sin salt**; el de `vendedor` es el hash conocido de `1234`. Hoy el
   login entra por Google OAuth y la tabla se usa como whitelist de rol (es la que autoriza
   `lk_faq-admin:79` y el gate nuevo), así que no es login activo — pero el hash está
   publicado. *Fix*: dropear la columna si no se usa; si se usa, bcrypt/argon2. Y acotar el
   SELECT a `email, role`.
8. **`enviar_pedido` sin confirmación server-side.** La exigencia de "confirmación explícita
   del cliente" vive sólo en el prompt (`bot-conversation.ts:200-208`); no hay estado
   persistido que el backend valide. `wa_order_draft` existe y tiene 0 filas / 0 referencias en
   el código — es el lugar natural para el token de confirmación. Alcance limitado a la cuenta
   de quien escribe, de ahí la prioridad baja, pero permite pedidos no repudiables.
   Aparte: `index.ts:851` guarda `SUPABASE_SERVICE_ROLE_KEY` en una variable llamada `anonKey`
   y la manda como Bearer a una función `verify_jwt=false` — innecesario, y la expone en logs.

---

## 3. Robustez del flujo (lo que rompe la atención)

10. **Rate limit y blacklist sólo existen en `lk_chat-test`** (`:75-95`), no en el webhook real
    (0 hits de `wa_blacklist` / `wa_check_rate_limit` en `lk_whatsapp-webhook`). O sea que
    `sql/012` es tabla + RPC + setting (`wa_rate_limit_enabled=1`) que **no se aplican en
    producción**: un número blacklisteado sigue atendido y no hay tope de tokens por número.
    *Fix*: mover los dos chequeos al paso 0 de `handleMessage`, junto al killswitch.
11. **El alta de cliente nuevo tiene tres problemas** (`lk_whatsapp-webhook/index.ts`):
    - **Sin TTL ni reset** (:930-941, `getPendingLead` no filtra por fecha): quien abandona en
      el campo 4 y vuelve dos semanas después, su "hola, me pasás la lista?" se guarda como
      mail o dirección. Único escape: `RE_ALTA_CANCEL` (:204). *Fix*: expirar `pending` a las
      24-48 h y ofrecer "retomar / empezar de nuevo".
    - **`RE_ALTA_START` (:202) dispara con palabras genéricas** ("dale", "alta", "registro"):
      si al pedido de CUIT contestan "dale, ya te lo paso", arranca el alta y el CUIT del
      mensaje siguiente se guarda como `razon_social`. Y con ese arranque el lead queda **sin
      CUIT para siempre** (no hay paso de CUIT en `ALTA_STEPS`, aunque el comentario de
      :172-173 diga que se pide primero). *Fix*: frases explícitas ancladas + revalidar CUIT en
      cada paso.
    - **Dos leads `pending` simultáneos matan el alta en silencio**: `getPendingLead` (:223-231)
      usa `.maybeSingle()` e ignora el `error`, `crearLead` (:332-340) no chequea si ya hay uno,
      y `sql/013:31` sólo crea índice, **sin unique en `phone`**. Con dos filas, `maybeSingle()`
      devuelve null con PGRST116 que nadie mira → el paso 3b no intercepta nunca → "pasame tu
      CUIT" en loop para siempre. *Fix*: unique parcial `(phone) where status='pending'` +
      `.order().limit(1)`, y `crearLead` idempotente.
12. **`waPost` nunca lanza en error** (`lk_whatsapp-webhook/wa-api.ts:20-24`): loguea `!resp.ok`
    y devuelve el JSON de error como si fuera éxito. Por eso el `try/catch` de `flushOutbox`
    (:519-526) nunca dispara y siempre corre `bot_outbox_mark(status:'sent')` (:515) — el outbox
    marca como enviados mensajes que Meta rechazó, y nadie los reintenta ni los ve. Sumado a
    que **no hay ningún chequeo de la ventana de 24 h** antes de mandar texto libre (el
    comentario de :504 lo afirma pero no lo implementa).
    *Fix*: `throw` en `!resp.ok`; decidir template vs texto según `wa_message_status`.
13. **El pre-check de FAQ secuestra conversaciones del agente en curso** (:943-961): `handleFaq`
    corre en todos los mensajes sin mirar si hay un turno pendiente. El agente pregunta
    "¿confirmo el pedido?", el cliente responde "transferencia" → matchea `datos_transferencia`
    → le manda el CBU y el pedido queda colgado; peor, esa respuesta enlatada entra al
    historial. *Fix*: bandera de conversación en curso que saltee el pre-check, o whitelist de
    FAQs que puedan interrumpir.
14. **Un 400 por payload malformado tumba la cadena de modelos 5 minutos** (`_shared/llm.ts:386-391`):
    cualquier excepción llama `markDown` → `estado='caido'` + `cooldown_hasta` +5 min. Como el
    error es del request, falla igual con todos los proveedores → la cadena entera queda
    "caída". *Fix*: distinguir 4xx de request (no penalizar) de 401/429/5xx (sí).
15. **`lk_chat-test` sigue divergiendo del webhook en el teléfono**: usa `canonPhone`
    (`_shared/wa-api.ts:4-16`), que **saca el 9** (`5491162521635` → `541162521635`), mientras
    el webhook pasa el `from` crudo de Meta → historial, leads y blacklist quedan bajo claves
    distintas. Ni es consistente consigo mismo (:101 usa `phone` crudo, :119 `testPhone`).
    *Fix*: extraer el flujo a `_shared` y llamarlo con el mismo teléfono canónico.
16. **Menores**: saludo duplicado en el camino de FAQ (:955-957 envuelve `faq.reply` con
    `conSaludoSiCorresponde` y la FAQ `saludo_inicial` ya saluda) · la verificación GET lee sólo
    la env var (:1017) mientras `loadConfig` (:47) prioriza `app_settings`, así que rotar el
    verify token ahí devuelve 403 sin más síntoma · el gate de whitelist inserta una fila en
    `wa_alertas_humano` **por cada mensaje descartado** (:896-902, :656-665) → crece sin techo.

---

## 4. FAQs (lo que el cliente recibe mal)

Verificado contra la base viva; el matcher desplegado coincide con `sql/054` (md5 del cuerpo
normalizado idéntico), así que son fallas reales, no drift. Escribir `wa_faq` **siempre** por
`lk_faq-admin`, nunca por SQL directo.

17. **FAQ 4 nunca contesta la dirección del depósito.** `sql/021:8` le puso
    `db_lookup_type='order_status'`, y en `faq.ts:90-98` toda FAQ con lookup implementado sirve
    el lookup y descarta el texto. "¿Dónde queda el depósito?" → lista de pedidos (score 3.001,
    medido). La dirección (Virgilio 2788) es **inalcanzable**. Revisar FAQ 5, mismo caso.
18. **El rescate difuso otorga +1 sin guarda de longitud** (`sql/054:82`): `word_similarity`
    corre sobre cualquier keyword, incluso de 6 caracteres, y +1 es justo lo que `faq.ts:63`
    toma como match sólido. Medidos: *"me mandaron un producto roto"* → FAQ 31 → **"¡Hacemos
    envíos a todo el país!"** a un reclamo por rotura · *"cuanto es el flete a salta"* → mínimo
    de compra · *"hasta que hora atienden"* → marcas. *Fix*: exigir `length(nk) >= 8` y
    `word_similarity >= 0.75`, y/o bajar el aporte a 0.9 para que no empate con un keyword real.
19. **Tres `db_lookup_type` declarados y no implementados** → el token queda vacío.
    `faq.ts:153-160` sólo maneja `order_status`, `customer_discount`, `product_price`,
    `product_stock`, `order_modify` (+ `payment_data`). Activas con lookup inexistente:
    `product_search` (FAQ 34, 36, 37), `order_cancel` (39), `order_detail` (35), `order_create` (2).
    Resultado literal: *"¿venden ollas de acero?"* → **"Sí, trabajamos con ."**; *"qué modelos
    de sartén tienen"* → **"Tenemos estas opciones:\n\n¿Querés ver más…"**. Y el front las pinta
    como "el sistema completa el dato — no se edita" (`docs/index.html:1535, 1599, 1602`).
    *Fix*: implementar `product_search` o pasar esas FAQs a `inteligencia` (el agente ya busca).
20. **FAQ 14 (stock) tiene keywords genéricos que pisan otros intents**: `tienen`, `hay`,
    `queda`, `quedan`, `disponible`, con prioridad 60 gana empates. Medidos: *"tienen
    catalogo?"*, *"que horario tienen"*, *"hay algo nuevo?"*, *"tienen local a la calle"* → los
    cuatro reciben **"No encontré el artículo que mencionás"**. *Fix*: dejar sólo `tienen stock`,
    `hay stock`, `stock de`.
21. **Ninguna FAQ `needs_human` avisa a nadie.** `faq.ts:74-75` deja `notificarHumano()`
    explícitamente sin conectar, pero 5 FAQs activas (3, 7, 17, 33, 35) prometen contacto:
    *"me olvidé la clave"* → *"te va a contactar un asesor a la brevedad"* → nadie se entera.
    Es una promesa falsa en producción. *Fix*: insertar en `wa_alertas_humano` desde la rama
    `needs_human` (el patrón ya existe para el alta).
22. **Los datos bancarios están hardcodeados y una migración los rompe.** `sql/031:8` (última de
    la cadena 018→020→025→027→029→030→031) escribe `CBU: {cbu}` con **una** llave, y
    `renderTemplate` (`faq.ts:40`) sólo entiende `{{…}}`. La fila viva tiene el CBU **literal**
    (alguien lo arregló por el Panel), o sea el repo está desfasado y **re-correr `sql/031`
    manda "CBU: {cbu}" al cliente**. Además FAQ 15 duplica el CBU que FAQ 42 saca de
    `wa_descuentos_config.pago`: si se cambia en el Panel, FAQ 15 sigue mandando el viejo.
    *Fix*: FAQ 15 con `{{alias}}`/`{{cbu}}` y `db_lookup_type='payment_data'`; corregir `sql/031`.
23. **`wa_faq_lookup_tokens` guarda dos tokens CON llaves** (`sql/053:40,44` insertan
    `'{{alias}}'` y `'{{cbu}}'`), contra el estándar que declara `sql/051:31` y contra las otras
    20 filas. `docs/index.html:1605` pinta `+ {{` + token + `}}` y :1641-1647 envuelve otra vez
    → el editor ofrece `{{{{alias}}}}` e inserta eso → el cliente recibe **"Alias: {loeke.srl}"**.
    Queda además la fila stale `seller_contact / nombre_vendedor` (id 15), de un lookup que
    `sql/055` eliminó. *Fix*: `update wa_faq_lookup_tokens set token = trim(both '{}' from token)`
    y borrar la fila stale.
24. **Otros de matcheo, todos medidos**: *"mi pedido llego incompleto"* → gana FAQ 1 (2.001)
    sobre FAQ 35 (1.001) → el reclamo **no se escala** · *"a donde te mando el comprobante"* →
    FAQ 10 (Facturación) en vez de FAQ 20 (Cobranzas), y `a donde mando` no matchea *"a donde
    **te** mando"* · *"que precio tiene el 438E"* → FAQ 11 (la lista genérica, prio 72) sobre
    FAQ 12 (68), ya anotado en `ESTADO.md` y sigue vivo.
25. **`institutional_response` de FAQ 1 y 4 le habla de "su pedido" a quien no es cliente**:
    *"Estimado Cliente: Su pedido ya fue programado para el día \*----------\*"*. `sql/052:22`
    revirtió los tokens, pero el problema es el texto entero. Viola la regla del `CLAUDE.md`
    (institucional se sirve sin datos). *Fix*: reescribir sin fecha ni pedido, o poner `null`.
26. **`automation_level` incoherente en tres filas** → el dashboard miente: FAQ 41 es
    `semi_auto` con `requires_db_lookup=false` y `db_lookup_type=null` (es estática); FAQ 37 y
    39 son `semi_auto` con lookups inexistentes (punto 19). *Fix*: 41 → `full_auto`; 37/39 →
    `needs_human` o `inteligencia`.
27. **El front deja editar la respuesta de FAQs `inteligencia`**, que el bot nunca sirve
    (`faq.ts:87` devuelve `null` a propósito). `docs/index.html:1592-1620` le renderiza a la FAQ
    2 el textarea "Respuesta (plantilla)" con botón Guardar, sin aviso. Editarla no hace nada.
28. **Migraciones**: `sql/007:37` crea índices/trigger sin guarda y `:73` hace el seed **sin `ON
    CONFLICT`**; `sql/023:6` inserta `greeting_fallback` sin guarda (re-correrla duplica FAQ 40,
    y no hay unique sobre `category`/`subcategory`); `sql/033_wa_question_variants.sql` repite el
    patrón. Hay **dos archivos 033** y **falta el 019** — renumerar uno de los 033.
29. **`wa_question_group` / `wa_question_variant` / `wa_intent_response`
    (`sql/033_wa_question_variants.sql`) son tablas muertas** (0 referencias en `.ts`/`.html`) y
    con el seed apuntando a los `faq_id` **equivocados**: `(3,'pickup_cluster')` pero retiro es
    la 4; `(5,'customer_onboarding_cluster')` pero la 5 es fecha_retiro; `(7,'discounts_cluster')`
    pero descuentos es la 8. Si alguien las cablea al matcher, arrastra el corrimiento.
    *Fix*: borrar la migración, o corregir los ids antes de usarla.
30. **`tests/faq-tests.sh`**: 7 asserts que no cubren nada de lo de arriba, y dos que romperían
    con el fix del punto 22 (la línea 45 espera "Credicoop" y la 46 "CBU" en FAQ 15).

---

## 5. Operativo (falla todos los días)

31. **`pedido_recordatorio_25` falla contra Meta con #132001 "Template name does not exist in
    the translation".** 20 fallas hoy, y el **cron 23** (`bot-recordatorio-25`, 12:00 UTC
    diario) lo reencola todas las mañanas. Nadie mira `wa_outbox.error`. Estado del outbox: 54
    `failed` / 19 `held` / 13 `sent` (las 34 fallas viejas son `pedido_facturado_sale`, "flujo
    viejo desactivado 2026-09-01"). *Fix*: crear/aprobar la plantilla en Meta con el idioma
    correcto (`es_AR` vs `es`) — verificar con `lk_tpl-check` — o apagar el cron 23 hasta
    entonces. Y dejar de reencolar lo que ya falló por plantilla inexistente.
32. **575 escalaciones `pendiente` en `wa_alertas_humano`, de 57 teléfonos reales**, todas con
    motivo `whitelist_gate` (pico el 03/09: 525 de 53 teléfonos). Son clientes escribiendo al
    número sin recibir nada, y **no hay ningún consumidor de esa cola**. Es decisión de
    producto: abrir la whitelist, o contestarle algo institucional al bloqueado. En los dos
    casos falta una vista/consumidor que cierre las filas (y ver el punto 16).
33. **`wa_real_redirect_date = 2026-09-04`** → con la ventana de 48 h de `dentroVentana`, al
    2026-09-07 está **cerrada**: cuando vuelva la facturación, `lk_factura-check` devuelve
    `dormant_real` / `fuera_de_ventana` y no se envía nada, **sin error visible**. Poner la
    fecha del día cuando arranque la tanda.
34. **`ANTHROPIC_API_KEY` no existe en `app_settings`** — sólo en el env secret. `loadConfig`
    **lanza y mata el mensaje entero** si tampoco está en env. Single point of failure sin
    fallback.
35. **`bot_token_usage` congelado desde el 26/08** (7 filas): el camino del agente no loguea
    consumo, así que `checkQuota` (`llm.ts:145-191`) calcula los límites diarios/rpm sobre una
    fracción del tráfico. Aparte, la cadena real de modelos (`tarea='general'`) es **Google
    primero** (`gemini-3.5-flash-lite` p1, `gemini-2.5-flash` p2, `claude-sonnet-4-6` p3), que
    **no coincide con la tabla "Modelos Claude" del `CLAUDE.md`** (haiku/sonnet) — actualizar
    esa tabla al chain real.
36. **Faltan dos crons que el repo declara** (`sql/005`): `wa_expire_drafts` y
    `wa_reactivacion_clientes`. Y el que existe (jobid 21) apunta a `lk_outbox-flush`, no a
    `lk_whatsapp-webhook {"action":"flush"}` como dice el archivo. Hoy no duele porque
    `wa_order_draft` tiene 0 filas.

---

## 6. El repo no describe lo que corre

37. **`sql/001` y `sql/006` mienten.** `customer_phones` **no existe** en la base; el trigger
    `trg_order_tracking_notify` que corre es otra implementación (usa `bot_customer_whatsapps`,
    inserta en `wa_outbox(body, context, ref_id)`, tiene `EXCEPTION WHEN OTHERS`). `sql/002`
    declara `wa_outbox.customer_id`, que no existe (la base tiene `context, ref_id`). Quien
    aplique el repo a un proyecto limpio obtiene un sistema que no arranca.
    *Fix*: reescribir 001/002/005/006 para reflejar lo que corre, dejando constancia de la deuda.
38. **Toda la capa `bot_*` sobre la que realmente corre el bot no está versionada en ningún
    lado**: `bot_historial_chat`, `bot_conversaciones`, `bot_customer_whatsapps`,
    `bot_facturado_avisos`, `bot_pending_notifications`, `bot_reactivacion_*`,
    `bot_knowledge_base`, `bot_directrices` + sus RPCs (`bot_guardar_mensaje`,
    `bot_conv_get_modo`, `bot_flush_outbox`, `bot_encolar_recordatorios_25`,
    `bot_reactivar_inactivos`). Tampoco `wa_clientes_telefono`, `wa_factura_consolidada` ni
    `wa_is_human()`. El repo versiona la capa `wa_*` nueva y no la que sostiene el día a día.
39. **`docs/FLUJOS.md` es íntegramente de la etapa de diseño**: acepta `CLIENTE: 1234` (que
    `extractCuit` rechaza — exige 11 dígitos con módulo 11), promete *"No entendí…"* cuando el
    código **no manda nada** (:985-989), y cita tres templates inexistentes
    (`pedido_programado`, `pedido_entregado`, `reactivacion_cliente`; los reales son
    `pedido_contado_s`, `pedido_credito_p`…). Nada del killswitch, modo humano ni alta paso a
    paso. *Fix*: reescribirlo contra `handleMessage` 0→6, o degradarlo a "diseño original".
40. **`docs/faq-dashboard.html` y `docs/top30-faq.html` son snapshots estáticos, públicos y
    desfasados** (array `faqs` hardcodeado, sin Supabase): dicen "39 Total Activas · 18 AUTO ·
    15 SEMI-AUTO · 4 HUMANO" cuando la base tiene 28 activas (9 `full_auto`, 13 `semi_auto`, 5
    `needs_human`, 1 `inteligencia`), y traen copies ya revertidos.
    `DEPLOYMENT-CHECKLIST.md:14` pide mantenerlos "sincronizado con BD" — imposible siendo
    estáticos. *Fix*: borrarlos o marcarlos "snapshot histórico, no autoritativo".
41. **`docs/mapa-flujo-bot.html` no muestra el alta de cliente nuevo** (paso 3b del webhook,
    :930-943, que intercepta **antes** del FAQ), ni el handler de adjuntos (:647), ni la rama
    `inteligencia`. Su copy de no-cliente (:186) ya no es el del código (:381). El mismo copy
    viejo está en `AGENTE.md:94` y `ESTADO.md:128`.
42. **`TESTING.md` y `DEPLOYMENT-CHECKLIST.md` validan código muerto**: piden probar `matchFAQ()`,
    `detectIntent()` y `conversationalReply()` de `_shared/claude.ts`, **que no lo importa
    nadie** (el camino vivo es `wa_faq_match` + `handleFaq` + tool-use). Su SQL de debugging
    (`TESTING.md:196-215`) consulta `wa_conversations`, donde el webhook **no escribe** (sólo
    `lk_chat-test` y `lk_templates`; el historial real va a `bot_historial_chat`) y filtra
    `intent LIKE 'faq_%'` cuando `faq.ts:139` setea `intent='faq'` → siempre 0 filas.
    `DEPLOYMENT-CHECKLIST.md:82` manda pushear a una rama vieja, contra la regla del `CLAUDE.md`.
    **Nota**: el `CLAUDE.md` también dice que `wa_conversations` es el log de auditoría — no lo es.
43. **`README.md` marca como "🔲 pendiente" 4 features que están en uso**, describe una
    arquitectura que no es la viva (`parse_intent(haiku)` → `wa_order_draft` →
    `submit_order_fast`; el real es tool-use con `enviar_pedido`) y lista dos archivos SQL que no
    existen. **`.env.local.example`** define `META_ACCESS_TOKEN` / `META_PHONE_NUMBER_ID` /
    `WEBHOOK_VERIFY_TOKEN`, pero `loadConfig` (:45-48) lee `LK_WA_TOKEN` / `LK_WA_PHONE_ID` /
    `LK_WA_VERIFY_TOKEN` → el testing local documentado **aborta siempre** con "Faltan
    credenciales".
44. **Seis loaders del dashboard no chequean `error`** (`loadFaqs` 1543, `loadAgentePage` 1491,
    `loadConsultas` 1801, `loadEvals` 1899, `loadModelos` 1995, `loadAgenteHistory` 1741):
    destructuran sólo `{ data }`, y PostgREST no lanza — un 401/RLS devuelve
    `{data:null,error}` y la pantalla dice "Sin consultas" como si estuviera legítimamente
    vacía. **Peor en `loadAgentePage`: si falla, `agenteMd = ""`, los textareas quedan vacíos y
    un "Guardar" posterior sobrescribe el documento rector completo con una sola sección.**
    *Fix*: `if (error) throw error` en los seis, y bloquear el guardado si `agenteMd` no cargó.
45. **`ESTADO.md:167-169` subdeclara las edge functions fuera del repo**: además de
    `lk_notif-facturado` y `lk_outbox-flush` están desplegadas y sin versionar
    `lk_factura-consolidar` (v15) y `lk_wh_stage` (v3), más la legacy `whatsapp-webhook` (v153),
    que no figura en ninguna parte.

---

## Cómo verificar cosas acá

```bash
# estado real de una función SQL
select pg_get_functiondef(p.oid) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname='<nombre>';

# qué ve anon (los grants son independientes del JWT)
select has_table_privilege('anon','public.<tabla>','SELECT'),
       has_function_privilege('anon','public.<fn>(<args>)','EXECUTE');

# y con RLS, simulando el claim (sin esto, toda policy con auth.role() da 0 filas
# y parece que rompiste algo que no rompiste)
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select count(*) from public.wa_faq where is_active;
```

Proyecto Supabase: **PaginaLK `kwkclwhmoygunqmlegrg`** (el bot). El de facturación es **ISIS
`hrxfctzncixxqmpfhskv`** — si un número de facturación no cuadra, la data está allá.
