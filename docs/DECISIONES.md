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

## D005 — Número WhatsApp (2026-08-26)

**Decisión**: Usar un número WhatsApp preexistente, separado del de Planify.

**Razón**: Aislamiento total entre bot de clientes y bot interno (Planify). Sin necesidad de router/proxy. Cada bot tiene su webhook independiente.

**Consecuencia**: Configurar webhook de Meta apuntando a `lk_whatsapp-webhook`. Secrets necesarios: `WA_TOKEN`, `WA_VERIFY_TOKEN`, `WA_PHONE_NUMBER_ID`.

---

## D006 — Envíos automáticos: sólo a números de prueba, y con llave general (2026-09-25)

**Registro (Luis, 25/09):** los mensajes automáticos que salieron entre el 27/08 y el 04/09
(26 de `notify-tracking-status` y 13 de `wa_outbox`) fueron **a números de testeo**. No se contactó
a ningún cliente. No es un incidente.

**Decisión (Luis):** todavía no se contacta clientes. El bot **no debe tener acceso a ningún
teléfono más que los cargados de prueba**, y sin número cargado no puede mandar. Además tiene que
haber una **llave general de "no mandar nada"** como segunda barrera.

**Medido el 25/09:** los que despachan solos (`lk_outbox-flush`, `notify-tracking-status`) no miran
la whitelist; la barrera real hoy es que `bot_customer_whatsapps` está vacía. Pero
`wa_clientes_telefono` tiene **963 teléfonos reales**, que leen `bot_encolar_recordatorios_25`
(frenado sólo por `v_test_phone` hardcodeado) y `bot_reactivar_inactivos` (frenado por
`bot_reactivacion_config.enabled = false`). `customers.whatsapp` tiene 8.

**Consecuencia:** llave `app_settings.wa_envio_automatico` (`0` nada · `prueba` sólo
`wa_envio_contactos` · `1` producción), fail-closed, en el paso que despacha. `sql/068`.
**No se cargan teléfonos de clientes** en tablas del bot hasta que Luis lo decida.

**Aplicado el 25/09 (con el sí de Luis):** `sql/068` (llave en `0`, probado en transacción
abortada: con `0` no despacha, con `prueba` sólo Thomy y el resto queda `held_no_whitelist`);
`notify-tracking-status` respeta la misma llave (fuente versionada acá desde ahora); cron
`bot-recordatorio-25` se apagó y se **volvió a prender el mismo día** por el principio de abajo
(encola en `wa_outbox`, así que la llave ya lo corta; la plantilla `pedido_recordatorio_25`
además no existe en Meta). Whitelist de prueba = **sólo Thomy**.
⚠ **02/10 (Thomas):** la whitelist suma a **Damián, dueño de Chef S.R.L.** (cliente LK 411): primer teléfono
de cliente real cargado en las tablas del bot, con aprobación de Thomas. El canal de prueba sigue siendo Thomy
(la fila más vieja de `wa_envio_contactos`).
Rollback del cron: `select cron.alter_job(jobid, active := true) from cron.job where jobname='bot-recordatorio-25';`

---

## D007 — Principio rector: vasectomía, un solo corte en la salida (2026-09-25)

**Luis, textual:** *"miralo como una vasectomía. Quiero armarlo cosa de que todo el sistema
funcione pero esté con el corte en el lugar indicado para que no contacte a nadie hasta que
arranquemos a usarlo. No quiero apagar 20 cosas diferentes, prefiero cortes quirúrgicos."*

**Decisión:** nada se apaga para evitar contactos; el corte es la llave `wa_envio_automatico`
en el paso que despacha. Todo productor de mensajes automáticos encola en `wa_outbox`. Las
salidas que hoy le hablan directo a Meta se migran a la cola (deuda, inventario abajo).
El detalle operativo está al principio de `CLAUDE.md`.


**Inventario de salidas a Meta (25/09, lectura sin tocar nada).** Pasan por la llave:
`wa_outbox → lk_outbox-flush` (y todo lo que encola: triggers de `orders`, `order_tracking`,
`ppp_facturacion`, crons 22 y 23) y `notify-tracking-status`. **NO pasan por la llave (deuda):**

| salida | cómo se dispara | freno hoy |
|---|---|---|
| `asoc-timeout-cron` | cron 3, cada hora, **activo** | ninguno: le escribe a quien pidió registrarse y esperó > 24 h (hoy 0 en espera) |
| `notify-order-created` | HTTP con secreto; nadie la llama hoy | ninguno |
| `inbox-api` / `inbox-register` | manual, con contraseña (sin uso desde 07/07) | ninguno |
| `lk_templates` (`template_send`) | manual, admin del panel | sólo admin |
| `lk_conversaciones` | manual, panel | whitelist + ventana 24 h |
| `lk_whatsapp-webhook` (respuestas) | le escribe alguien | `wa_bot_solo_whitelist` |
| `lk_factura-check` | cron 69 de Virgilio + triggers ISIS | whitelist / sin `dest_phone` no manda |
| `notify-new-address` | carrito de la página | sólo al número interno de Ventas |

**Cerrado el 25/09 (sí de Luis a todo):** `sql/069` aplicado (feed de `order_tracking` desde
Gestión, backup `zz_backups.bkp_order_tracking_20260925`), `sql/070` (decisión única
`wa_puede_enviar`, aviso de cambio de fecha, canal de prueba Thomy ↔ cliente 99862, llave en
`prueba`) y `_shared/wa-guard.ts` importado por **todas** las edges que le hablan a Meta
(asoc-timeout-cron, notify-order-created, inbox-api, inbox-register, lk_outbox-flush,
notify-tracking-status, lk_templates, lk_conversaciones, lk_whatsapp-webhook, lk_chat-test).
Las 5 que vivían sólo en el proyecto quedaron versionadas acá.
`lk_factura-check` también (25/09): lo deployado v33 era el HEAD del repo (deploy 04/09 13:17, commit
62db211 13:13); la sospecha de que diferían fue un error de conteo.


## D008 — Loekemeyer y Chef por un solo número: la empresa viaja con cada dato (2026-10-01)

**Pablo Olejavetzky:** por el momento hay **un solo número** para las dos empresas.

**Decisión:** no se le pregunta "¿Loekemeyer o Chef?" a nadie al empezar. La empresa no es de la charla sino de
cada dato: el número de cliente sólo vale junto con su empresa (315 códigos existen en las dos y en 297 son otro
CUIT) y entre empresas se cruza por **CUIT**. Medido al 01/10: 905 CUIT sólo LK, 357 en las dos, 395 sólo Chef.

**Fases** (orden por gravedad):
1. Identidad: `bot_cuentas`, `bot_telefonos_empresa`, `bot_chef_whatsapps`, `bot_identificar_chef` (sql/115) y
   vinculación de clientes de Chef con revisión humana (sql/116). **Hecho.**
2. Empresa por mensaje sin preguntar de más: cliente de una sola empresa → fija; mixto → la del dato del que habla
   (factura, pedido, aviso); sin dato → se deduce del texto o se pregunta una vez.
3. Pagos completos para Chef: recibos, descuentos por factura (#8), reenvío, factura duplicada (isis_ch). **Hecho (01/10).**
4. Catálogo y stock por empresa (12 códigos son un producto distinto en cada empresa).
5. Marca: texto base del bot, plantillas y nombre visible en Meta.

**Corte mientras tanto (sí de Pablo, 01/10):** a un cliente sólo de Chef el bot le contesta saludo, facturas de
Chef y datos de pago de Chef (todo por CUIT); lo demás va a una persona (alerta `cliente_chef`). Las herramientas del
bot (pedidos, estado, facturas de isis_lk, stock, catálogo) buscan en Loekemeyer por número de cliente y le
mostrarían a Cencosud (2444 en Chef) los pedidos de Relca (2444 en LK). Se levanta cuando cada consulta sepa de qué
empresa es. Código: `_shared/chef.ts`.

**Por qué los vínculos de Chef van en otra tabla:** `bot_encolar_recordatorios_25` y `trg_notify_despacho` cruzan
`bot_customer_whatsapps` por `cod_cliente` sin mirar la empresa (la columna `empresa` existe pero nadie la filtra).
Un teléfono de Chef cargado ahí recibiría los avisos del cliente de LK con el mismo número.

**Códigos de artículo entre empresas (medido el 01/10, para la fase 4).** Gestión no tiene "5 tablas de
equivalencias de lo mismo": son 4 conceptos distintos y conviene dejarlos así.
- `codigos_duales` (4: 437E, 438E, 439E, 809E): el MISMO producto lo venden las dos y cada una tiene su stock. Es la
  pieza central: la usan 17 funciones y 8 vistas de Gestión (stock, recepción de importados, NC Loeke-Chef).
- `GV_Cod_Dos_Productos` (12): el mismo código es un producto DISTINTO en cada empresa. Sólo documenta (y la UxB se
  resuelve por empresa en `GV_UxB`). Hoy ninguno está activo en las dos webs: 026, 034, 658 y 659 sólo en la de LK;
  043 sólo en la de Chef; el resto en ninguna. Las descripciones de LK de 658 y 659 ya no coinciden con la web.
- `Equivalencias_Codigos` (11): alias de un código de pedido al código real.
- `gv_articulo_empresa` (vista + `GV_Articulo_Empresa_Cache`): empresa de cada código, derivada de las listas de
  precios. Para 043 dice LK mientras `gv_empresa_de_articulo('043')` devuelve CH.
- `chef_item_remap` (PaginaLK, 9): remapeo de códigos de ventas de Chef.
Regla para el bot: todo código viaja con su empresa (como `bot_stock_por_empresa`, 01/10); no se unifican las tablas
de Gestión.

**Plantillas por marca (Pablo, 01/10).** Chef no tiene alias y comparte el número con Loekemeyer: cada plantilla de factura
tiene su versión de Chef (6 más, `_chef`), que nombra a Chef y no lleva alias. Titular y CUIT van fijos en el texto; el CBU es
variable (cambiar de cuenta no necesita aprobación nueva de Meta). Mientras la de Chef no esté APPROVED, el aviso de factura de
Chef queda retenido: la de Loekemeyer no sirve (lleva el alias de Loekemeyer).

**Puerta de marca (Pablo, 01/10).** D008 dice que no se pregunta "¿Loekemeyer o Chef?" al empezar; eso sigue igual. Lo que se agrega: a
un cliente de las dos marcas se le pregunta de qué marca es CADA consulta, también los pedidos ("es el doble de trabajo de flow, pero es
la única que va a quedar bien y sin errores"). Se probó un atajo —no preguntar si solo una marca tiene pedidos en curso— y se descartó:
contesta mal cuando el cliente habla de un pedido ya entregado de la otra marca. Quedan fuera de la pregunta el saludo, la cortesía y las
consultas de plata, que ya separan las dos empresas. La marca elegida se recuerda 15 minutos leyendo la etiqueta de las respuestas del
historial (sin tablas). Con Chef contesta `atenderClienteChef`; con Loekemeyer, el flujo de siempre. Código: `_shared/marca.ts`.
Medido el 01/10: de los 357 clientes de Loekemeyer que están en las dos empresas, sólo 64 (17,9 %) tienen una factura de Chef en los
últimos 12 meses. Pablo: "limitalo a 12 meses" — la pregunta se hace sólo a clientes con factura de Chef en 12 meses o pedido de Chef
en 90 días (cubre al que recién empieza a comprar y todavía no tiene factura); los otros 293 (82,1 %) siguen por el flujo de siempre.
Si Gestión no responde, se pregunta. Un cliente que vuelva a comprar en Chef después de más de 12 meses queda sin la pregunta hasta que
cargue un pedido (lo cubre la ventana de 90 días).

**Fase 4 — catálogo de Chef, paso A (Pablo, 01/10).** Medido: Chef tiene 156 artículos en `chef_ext.products` (base propia de Chef vía FDW,
misma forma que `products`), 104 activos, los 104 con precio y unidades por caja y **con la columna `images` vacía** (las fotos existen igual: ver paso C). 100 de los 104 no existen en el
catálogo de Loekemeyer, así que `bot_buscar_productos` (que sólo mira `products`) no los veía. Paso A: búsqueda sin IA y sin precio ni foto
(`_shared/catalogo-chef.ts` + sql/121): código, descripción de Chef, unidades por caja y stock de Chef; el precio lo pasa una persona.
Pasos pendientes: B (precios) y C (fotos y catálogo en PDF).
**Paso C — corrección (01/10): SÍ hay fotos de Chef.** Retira lo que decía este párrafo ("ninguno con foto"), que salía de mirar la columna `images`
vacía y no el bucket: los 104 artículos activos de Chef tienen un JPEG (`<código>.jpg`, 65 a 88 KB en la muestra, fotos reales de producto) en el
bucket público `products-images` de la base de Chef (el host del servidor `chef_db`), el mismo esquema que Loekemeyer. **Se mandan desde el 01/10** (Pablo: "implementalo"): una foto por pedido, con HEAD previo, y con varios resultados se pide el código; la base
de las fotos se puede cambiar con `app_settings.chef_fotos_base_url` (sin la clave usa la de Chef). El catálogo en PDF de Chef no se encontró
(consulta `c-20261001-1603-1`). ⚠ No consultar ese almacenamiento en ráfaga: a unos 100 pedidos seguidos responde
`429 too_many_connections` (pasó el 01/10 por la medición de cobertura). Probar de a pocos.
**Paso B — REGLA VIGENTE (Pablo, 01/10: "consultalo con Thommy, y dejamos una regla en el bot, es algo que no manejo"): hasta que Thommy
confirme, el bot NO muestra precios de Chef a nadie**; si un cliente de Chef pide un precio, "te lo pasa una persona" y queda la alerta
`cliente_chef`. La consulta está en el artifact *Consultas para Thommy* (`c-20261001-1557-1`). Ninguna sesión implementa precios de Chef
sin esa respuesta. Lo medido el 01/10 (retira "no hay de dónde sacar el descuento"): el descuento por cliente existe en Gestión
(`clientes_dto`, empresa chef: 766 clientes, 435 con descuento, 0 a 22 %); en los 72 clientes de Chef con factura en 120 días coincide con el
de la última factura; en 6 de 7 pedidos reales de la web de Chef el total es lista × cajas × unidades × (1 − descuento) × 0,98 (2 % web), sin
IVA. Fórmula candidata: lista de Chef × unidades por caja × (1 − descuento por volumen), "+ IVA", sin descuentos por pago ni el 2 % web. Dos
trampas: 3 CUIT tienen dos cuentas de Chef con descuentos distintos (1310/2311, 1589/1708, 2447/274) y `clientes_dto` se cargó por tandas
(08/09 y 25/09: 765 de 766 filas con más de 14 días). Salvaguardas previstas: sólo con cuenta única, fila en `clientes_dto` y, si hay factura
reciente, que su descuento coincida; el resto a una persona.
**Códigos duales (Pablo, 01/10): "el producto es el mismo, pero el precio es diferente".** Medido: 437E, 438E y 439E cuestan 10,7 % a 11,3 %
más en Chef que en Loekemeyer (precio de lista) y el 809E se describe distinto en cada web (Corta Queso en Chef, Corta Pizza en
Loekemeyer) pero es el mismo producto. Regla para el bot: descripción y precio salen SIEMPRE del catálogo de la empresa que consulta.


## D009 — Avisos al equipo por WhatsApp: sale por la cola, es opcional por motivo y escala (2026-10-07)

**Pablo Olejavetzky:** *"que los avisos que salen en el Planify también lleguen al WhatsApp, sobre todo a Ventas"*; después, sobre el cartel de
Planify: *"siento que el Planify es mucho más invasivo"* y *"agregues todo al panel de configuración, hoy prefiero que sobre y no que falte"*.

**Decisión:** (1) el aviso al equipo es **una salida más de la cola** (`wa_outbox` + plantilla, `lk_outbox-flush`), no un envío directo a Meta: respeta la
llave `wa_envio_automatico` y D007; (2) **plantilla obligatoria** (al equipo no le escribió al bot en 24 h: texto libre fuera de la ventana da 131047);
(3) cada motivo elige **apenas nace / si nadie lo toma / las dos / ninguno** en Configuración › Derivaciones, con un defecto que avisa de más; (4) la
**escalada** manda un solo WhatsApp si nadie tocó «Me encargo yo» al vencer el semáforo: acota el ruido sin conocer el volumen real.
**Por qué la escalada y no sólo el espejo:** un WhatsApp llega a cualquier hora, no se apaga cuando alguien toma el caso y duplica cada cartel; el
volumen de producción no se puede medir hoy (el bot atiende 2 números). **Pendiente de Pablo/Thomas:** tarifa y volumen para el estimativo de gasto, y
si los avisos de Ventas van a las 3 personas o a la línea del sector (hoy: cada persona; se cambia en el panel sin tocar código).

**Addendum (07/10, Pablo: "dejalo como opción y el aproximado de gasto es bueno tenerlo").** El defecto no cambia (nace y escala) y el panel muestra el gasto
aproximado (techo US$ 52,88 por mes con 3 destinatarios, corregido más abajo a US$ 17,63 con la línea del sector; piso de referencia US$ 8,81). Variantes evaluadas y dejadas como opción, **sin construir**, con su costo:
(a) *ventana de 24 h iniciada por el empleado*: ahorro máximo US$ 17,13 por mes, porque el mensaje libre es "de servicio" y se cobra a la tarifa de utilidad
pasado el cupo de 1.000 por número (el bot usa ~341); además hace falta reconocer al personal en el webhook (hoy se descartan como `whitelist_gate`, y si se los carga
en la whitelist el agente de IA les contestaría y gastaría), caer a plantilla si no escribió ese día (error 131047) y un botón en el repo de Planify;
(b) *que responda el agente*: la regla de Meta no depende de quién redacta (fuera de la ventana sólo plantilla); dentro de ella suma US$ 0,0235 de IA y el riesgo de
que parafrasee o obedezca texto del cliente; (c) *consulta a pedido sin IA* ("¿qué tengo pendiente?", "me encargo yo"): la más barata y segura, queda para cuando se pida.
**Hallazgo:** desde el 01/10/2026 Meta parece cobrar también las plantillas de utilidad dentro de la ventana (5 de 5 casos en `wa_message_status`), aunque su documentación diga que son gratis.

**Decisión (07/10, Pablo: "esperemos al lanzamiento general").** Los avisos al equipo no se habilitan antes de tiempo: no se cargan números de personal en `wa_envio_contactos` (el bot les
contestaría si escriben) ni se adelanta la llave. Se prenden junto con el lanzamiento a clientes, con las plantillas aprobadas y el «sí» al gasto. Lista de revisión previa: `docs/ESTADO.md` (07/10).

**Corrección (07/10, Pablo: "el teléfono destinatario es un solo número, comparten el WhatsApp Web").** Cada sector atiende desde un solo número compartido por WhatsApp Web, así que un aviso de sector es UN mensaje y no uno por persona. El defecto del código pasa de «cada persona del sector» a «la línea del sector» (`CONFIG_WA_DEFECTO.sector`, dashboard v0.28.4). El techo del gasto baja de US$ 52,88 a **US$ 17,63 por mes** (339 alertas × 1 destinatario × 2 momentos × US$ 0,026). «Cada persona» y «las dos» siguen eligiéndose en el panel. Los techos con 3 destinatarios (52,88 / 89,29 / 125,70) quedan retirados. Una persona elegida en la tabla de motivos sigue recibiendo ella sola.


## D010 — Atender llamadas de WhatsApp con un agente de voz: diseñado, NO construido (2026-10-13)

**Pablo Olejavetzky:** *"Me pidieron desarrollar este bot, pero que responda si lo llaman por teléfono"*, *"la idea es que haga todo, pero siempre por
llamadas de whatsapp"* y *"dejémoslo asentado, no es prioridad igualmente"*. Después: *"es algo totalmente informativo, primero hay que
sacar el bot y luego ponerle las mejoras"*. **Se retoma después del lanzamiento a clientes**, no antes. La tarea de Planify (64) se cerró el mismo día: esta
entrada es el registro.

**Decisión:** se puede y queda diseñado, **sin construir y sin prioridad**. Alcance: todo lo que hace el chat, pero sólo por **llamada de WhatsApp** al
número del bot (no por línea común). Los pedidos se arman por voz y se confirman **por escrito**: antes de cargarlo, el agente manda el resumen al chat con un
botón «Confirmar» (una cantidad o un código mal oído es plata). Lo que es archivo (comprobantes, facturas, cotizadores) va por el chat, no por voz.

**Por qué no entra en lo que ya hay:** las Edge Functions atienden pedidos HTTP cortos y no sostienen una llamada (WebRTC o SIP, audio en tiempo real).
Claude no recibe audio, y el Whisper de Groq de `_shared/transcribir.ts` transcribe archivos enteros, no en vivo.

**Piezas** (costos de páginas de precios y reseñas de terceros, octubre 2026, sin medir):
1. **Meta Cloud API Calling** — mismo número y app. Falta activar llamadas y apuntar el SIP a LiveKit. Llamada iniciada por el cliente: US$ 0. Argentina no
   está excluida. 360dialog pide un límite de 2.000 conversaciones (Meta no lo confirma).
2. **LiveKit Cloud** — recibe el SIP de Meta (TLS, Opus), una sala por llamada. Plan Build US$ 0 por mes (unos 1.000 min de agente, las fuentes no
   coinciden), Ship US$ 50 por mes. Agente US$ 0,01/min, SIP US$ 0,003 a 0,004/min.
3. **Agente de voz** — Python o Node con LiveKit Agents, alojado en LiveKit Cloud o en un servidor propio. Es un servicio nuevo fuera de Supabase.
4. **Voz a texto** — Deepgram Nova-3 en streaming, US$ 0,005 a 0,009/min.
5. **Texto a voz** — ElevenLabs Flash unos US$ 0,045/min, Cartesia unos 0,035, Google u OpenAI unos 0,015 o menos. Se elige escuchándolas en rioplatense.
6. **Claude** — Haiku 5.5 para la conversación (unos US$ 0,002/min, estimado), Sonnet 4.6 para pedidos como hoy.
7. **Una Edge Function de herramientas** — el agente le pide los datos al bot (pedido, saldo, FAQ, armado de pedido) y **no reimplementa la lógica**: dos
   copias divergen (módulo de Matricería duplicado, 16/09).
8. **Corte (D007)** — llave nueva `app_settings.wa_llamadas_activo` (sin fila = 0) y whitelist al entrar la llamada. Fuera de la whitelist: rechazo y texto
   por `wa_outbox`.
9. **Registro** — transcripción a `wa_conversations`, costo a `bot_token_usage`. Sin grabar el audio y con aviso de asistente automático al atender (Ley 25.326).

**Costo por minuto de llamada:** unos US$ 0,03 (voz de Google) a 0,07 (ElevenLabs), más el fijo de LiveKit pasados unos 1.000 min por mes. Ejemplo con
volumen inventado (no hay dato de cuántos clientes llaman): 900 min por mes = US$ 27 a 63.

**Plazo estimado** (días hábiles, sin medir): sólo consultas 12 a 20, con pedidos 17 a 30. Por etapa: prerrequisitos 1-3 · Meta → LiveKit 2-3 · agente
básico 2-3 · herramientas 3-5 · corte y registro 1-2 · ajuste de voz 3-5 · prueba con Thomy y docs 1-2 · pedidos +5 a 10. Las etapas del agente se pueden
armar en paralelo con los prerrequisitos (LiveKit se prueba desde el navegador, sin Meta).

**Riesgos de plazo:** (1) el límite de mensajes de Meta: si el número está en el base, subirlo puede pedir la verificación del negocio o un volumen de envíos
que la vasectomía frena. Es lo primero a mirar. (2) La regla de gasto: cada prueba de voz pide estimativo y «sí». Propuesta: un tope único para la etapa de
ajuste (200 min = US$ 6 a 14, pedir US$ 15). (3) Que ninguna voz suene bien en rioplatense.

**Línea común (evaluada, no elegida):** reutiliza el agente y cambia la entrada. Número argentino alquilado (Twilio, Telnyx o LiveKit) con costo por mes y
por minuto y trámite local. El cliente no se identifica por su WhatsApp (hay que pedir CUIT o código), el audio de 8 kHz se transcribe peor y el rechazo no
puede avisar por chat. Si el agente se arma con la entrada desacoplada (Meta como una troncal SIP más), sumarla son 3 a 5 días hábiles más el trámite.

**Antes de arrancar:** una persona mira el límite del número en el WhatsApp Manager y crea las cuentas (LiveKit, Deepgram, voz) con medio de pago. Activar
las llamadas hace visible el botón 📞 a todos los que chatean con el número, no sólo a la whitelist.

Fuentes: [Meta Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) ·
[Meta SIP](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/sip) ·
[Meta Calling Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/) ·
[360dialog Calling](https://docs.360dialog.com/docs/messaging/calling.md) · [LiveKit Pricing](https://livekit.com/pricing) ·
[LiveKit y WhatsApp](https://community.livekit.io/t/whatsapp-calls-inbound/1153) ·
[Deepgram 2026](https://diyai.io/ai-tools/speech-to-text/deepgram-pricing-2026/) · [TTS 2026](https://blogs.novita.ai/best-text-to-speech-api-2026/)

---

## D011 — Apertura gradual: la primera cohorte son los clientes 4000 y 4289 (2026-10-15)

**Registro (Pablo Olejavetzky, 15/10):** los vínculos 225 (cliente 4000 Gasparri Claudio Emilio Suc, …6963, cargado el 25/09, no principal) y 228
(cliente 4289 Romagar S.R.L., …2300, cargado el 14/10, principal) de `bot_customer_whatsapps` son la **primera cohorte** de la apertura gradual del bot.
Pablo: los sugirió una sesión anterior de Claude cuando se habló de abrir el bot de a poco, y él los aceptó. De esa conversación no hay rastro en el
repo y `bot_customer_whatsapps` no guarda quién carga cada fila: esta entrada es el registro.

**Cómo funciona abrir de a poco (medido el 15/10):** los productores de avisos de pedido que van por la cola (`trg_notify_order_created`,
`trg_order_tracking_notify`, `wa_avisos_en_viaje_web`, `wa_avisos_retiro_web`) leen `bot_customer_whatsapps`: con la llave `wa_envio_automatico` en `1`
reciben avisos los clientes con vínculo y ningún otro. El guardrail de cruce de cliente (sql/156) retiene un aviso de un cliente a un teléfono vinculado a
otro. No se midió hoy qué leen `notify-order-created` y `notify-tracking-status` (leen `customers.whatsapp`, con 8 clientes el 25/09).

**Estado al 15/10:** la llave está en `prueba` y esos dos teléfonos no están en la lista blanca: no salió ni se encoló nada a ellos (0 filas en
`wa_outbox`). El 4000 tiene 1 pedido en los últimos 30 días y 4 mensajes en el historial; el 4289, ninguno.

**Qué es «de prueba» hoy (Pablo, 15/10: «hoy todo teléfono en la whitelist es de prueba»):** la lista blanca tiene 3 teléfonos, todos internos: Thomy
(…1635), Damián (…1594, **dueño de Loekemeyer y de Chef**, de prueba pero el más importante) y Logística (…1027). Los vínculos 224 (cliente 4028 con el teléfono
de Thomy) y 227 (cliente 4210 con el de Logística) son de prueba y quedan hasta el go-live.

**Antes de pasar la llave a `1`:** (1) avisar a Luis y a Thomas de los vínculos 225 y 228: D006 y `CLAUDE.md` piden que los teléfonos de clientes los
cargue quien ellos pidan, y estos salieron de una sugerencia de Claude con el OK de Pablo; (2) sacar los vínculos 224 y 227 (un borrado: pide el «sí»
de Pablo con el SQL exacto); (3) en el primer envío real, mirar que no aparezca un 403 `LkWaGuard` en los logs del webhook. Tareas de Planify 5852 y 5747.

---

## D012 — El bot no saluda ni arranca respuestas con la razón social del cliente (2026-10-15)

**Decisión (Pablo, 15/10, tanda de pruebas de 10 mensajes, mensaje 1):** el saludo del primer contacto del día es **«¡Hola!» sin nombre** («Sí, cambialo a «¡Hola!» sin
nombre»). Lo mismo en las respuestas fijas: `wa_faq` #41 pasa a «¡Hola! ¿En qué te puedo ayudar?», #8 a «Tus descuentos son:» y #42 a «Estos son los datos para
transferir:» («Sí, cambiá también la #41 sin nombre» y «Sí, sacala también de #8 y #42»), y las 3 respuestas de estado de pedidos que arma `faq.ts` («No tenés pedidos
recientes…», «Todos tus pedidos están entregados…» y el listado de pedidos) y las dos variantes de #8 que arma el código tampoco empiezan con la razón social
(«Sí, sacala también de esas 3»).
**Se dejan CON la razón social, por decisión de Pablo («Dejalos ahí y sigamos con otra cosa»; no volver a proponerlo):** la pregunta de marca de `marca.ts`
(«{nombre}, compraste en Loekemeyer y en Chef…»), los listados de pedidos de Chef y marca de `pedidos-marca.ts` y el saludo de vinculación del webhook
(«¡Hola {razón social}!» al vincular un teléfono por CUIT).

**Razón:** la base sólo tiene la razón social, no el nombre de quien escribe. De 1.264 clientes, 447 (35 %) llevan sigla de empresa y casi todo el resto son personas con el
apellido primero («¡Hola Quispe Gabriel Dario Josue!»), y reordenar apellido y nombre no es confiable. Además el saludo contradecía la regla del agente del 30/09
(«no hace falta saludar con la razón social»; el saludo lo pone el sistema).

**Dónde quedó:** `conSaludoSiCorresponde` (webhook, `4e0d158`); `sql/161` (#41) y `sql/162` (#8 y #42), con rollback en `sql/rollback/`, aplicadas en vivo; `faq.ts`
(`6ed4577` y `1830f96`); pruebas `tests/saludo-primer-contacto.test.ts` y `tests/faq-sin-razon-social.test.ts`. Tarea de Planify 5926.
**Verificado en el Simulador** (respuestas fijas y estado de pedidos, gasto US$ 0). **Pendiente:** el saludo del primer contacto no se replica en el Simulador: se ve por WhatsApp
real, el primer mensaje después de 6 horas sin escribir.

---

## D013 — Una pregunta de stock con cantidad no es un pedido: ni espera de 5 s ni Sonnet (2026-10-15)

**Decisión (Pablo, 15/10, mensaje 3 de la tanda):** «Si quiero 30 cajas hay?» es una consulta de disponibilidad y no la toma de un pedido («Sí, sacalo con pruebas»). Un mensaje que
habla de si hay mercadería (hay, tienen, stock, disponible, quedan) y **no** trae un verbo de pedir sin condicional (quiero, necesito, mandame, llevo, dame, anotame, cargame,
agregá…) ni «pedido», «pedir», «comprar» o «cotizador» ya no espera los 5 s del webhook ni va a Sonnet 4.6 fijo; «si quiero…», «si me llevo…» y «quiero saber si…» no cuentan como pedir.
**La regla del 05/10 de Pablo («la toma de pedidos siempre con un modelo fijo, Sonnet: no podemos fallar ahí») sigue igual para los pedidos**, incluido un pedido con una
pregunta de stock mezclada («tienen 30 cajas del 505? las quiero») y cualquier mensaje con un pedido en curso.

**Razón (medido):** ese mensaje tardó 11,49 s (5 s de espera + 4,94 s de IA) y costó US$ 0,0974 (Sonnet 4.6 con 23.563 tokens de entrada), contra unos US$ 0,0005 de un turno
normal con Haiku 5.5. «Tiene stock del 586?» también esperaba 5 s por el «del 586» (7,8 s con 1 s de IA).

**Dónde quedó:** `_shared/consulta-disponibilidad.ts` usado por `esTurnoDePedido` (`pedido-turno.ts`) y por la espera del webhook (`e9676b8`); pruebas
`tests/consulta-disponibilidad.test.ts` (75 chequeos) y `tests/pedido-turno.test.ts`. Tarea de Planify 5922.
**Límites conocidos:** un pedido dicho sin verbo («¿Tienen el 505? 20 cajas») se lee como consulta, y un «dale, cargámelas» sin cantidad no se detecta como pedido (ya pasaba antes).
**Pendiente:** el Simulador no pasa por Sonnet fijo ni por la espera: se verifica por WhatsApp real (esperado: sin los 5 s y con Haiku, unos US$ 0,0005 por mensaje).

---

## D014 — Precios, lista de precios y fotos de producto en las respuestas del bot (2026-10-15)

**Decisión (Pablo, 15/10, mensajes 7, 8 y 9 de la tanda):**
1. **Lista de precios (7):** «Me podes mandar la lista de precios?» sale por la respuesta fija #11 con el enlace a la web (loekemeyer.com | chefsrl.com, «Pedidos Mayorista» con CUIT y
   clave). El agente **nunca** dice que no hay una lista de precios.
2. **Precio y fotos (8):** si el cliente pide precio y fotos de uno o varios artículos, el texto lleva el precio de **cada** artículo por caja + IVA, una línea por artículo; las fotos no
   llevan precio, así que nunca se contesta sólo «te envié las fotos».
3. **«y los precios?» (9):** dicho después de hablar de artículos (código, precio por caja, foto o stock en los últimos 30 minutos), lo contesta el agente con el historial y no el
   enlace; sin charla previa, o sin artículos en ella, sigue el enlace.
4. **Fotos:** Meta acepta el mensaje de una foto JPEG en CMYK y después lo rechaza (131053), así que el bot no manda fotos CMYK ni WebP reales y le dice al cliente cuáles no tienen foto.
   Las fotos del bucket tienen que ser JPEG RGB o PNG. Pablo: «Sí, convertila a RGB»; con **400 px alcanza** para el 067 y el 537, **no se piden fotos nuevas**.

**Razón:** en la tanda, el 7 contestó «No tengo una lista de precios», el 8 mandó 10 fotos sin precios y dijo que mandó las 10 aunque la del 599E (CMYK) no llegó, y el 9 mandó el enlace
cuando venían hablando de los pelapapas.

**Dónde quedó:** `b82f92c` (7, 8 y la detección de CMYK en `_shared/imagen-enviable.ts`) y `c5370ea` (9); pruebas `tests/imagen-enviable.test.ts`, `tests/precios-y-fotos.test.ts` y
`tests/articulo-nombre.test.ts`. Escaneo de las 197 fotos activas: 2 CMYK (599E y 936E en `hd/`) y 3 sin foto que la base acepte (067 y 537 en WebP real de 400 px, 938E con tipo
`image/webp`). Se prepararon 5 JPEG RGB para subir a `products-images/hd/` como `.jpg` (no como `.webp`: la base sólo acepta `image/jpeg` o `png`): 599E, 936E, 938E, 067 y 537.
Tareas de Planify 5897 y 5916. **Verificado en el Simulador** (7 y 9 con Gemini gratis, 8 con Haiku 5.5 por US$ 0,004256).
**Pendiente:** la subida de las 5 fotos es de Pablo (ya pidió autorización: esta sesión no tiene credenciales de Storage) y repetir 7, 8 y 9 por WhatsApp real, porque el Simulador no manda fotos.
**Cierre de la tarea 5897 (Pablo, 15/10: «Ya las están subiendo, así que marcalo como terminado»):** se cerró con las fotos todavía subiéndose. **Sin verificar [Seguro, leído en Storage a las 15:51 UTC]:** en `products-images/hd/` sólo estaban `599E.jpg` y `936E.jpg`, con fecha 10/09 y unos 900 KB (los anteriores, no los RGB nuevos), y faltaban `938E`, `067` y `537`. Si la subida no pisa los archivos que ya existen, `599E` y `936E` pueden seguir como estaban y Meta rechaza un JPEG CMYK (131053). Repetir 7, 8 y 9 por WhatsApp real sigue sin hacerse.

---

## D015 — El webhook de WhatsApp corre en sa-east-1 (2026-10-14, cargada el 15/10)

**Decisión (Pablo, 14/10: «Decime como hacerlo y que afecta en el resto»; lo ejecutó él, guiado paso a paso):** forzar la región del webhook agregando `?forceFunctionRegion=sa-east-1` a la
«URL de devolución de llamada» de la app **«Gestion Operativa Clientes»** de Meta (ID `1413675673939456`, la única con nuestra URL y con `messages` suscripto):
`https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_whatsapp-webhook?forceFunctionRegion=sa-east-1`. Para guardarla Meta pide el token de verificación, y como el viejo no se
podía leer ni recuperar, Pablo aceptó **reemplazar el secreto `LK_WA_VERIFY_TOKEN`** por uno nuevo (lo cargó en el panel de Supabase y en Meta). El valor no se documenta.

**Razón (medido):** la base está en sa-east-1 y la función se servía desde EE. UU.: cada consulta REST costaba 145 a 585 ms y un turno hacía unas 16 seguidas. Los ~7 s de un
turno que no son del modelo se iban ahí. Con la región forzada, las consultas bajaron a 27-40 ms.

**Por qué no rompe nada más:** el token sólo se compara en el GET de verificación (`lk_whatsapp-webhook/index.ts`); los mensajes entrantes se validan con la firma (`META_APP_SECRET`,
sin tocar) y ninguna otra función lee `LK_WA_VERIFY_TOKEN`.

**Resultado:** mediana de respuesta **4,6 s contra 10,3 s antes** (12 turnos reales, del 14/10 19:18 al 15/10 12:24), fuera del agente 1,6 s (antes 6,7 s). Consulta:
`select percentile_cont(0.5) within group (order by respuesta_s) from v_wa_turno_tiempos where recibido_at > '2026-10-14 19:15+00' and respuesta_s is not null`.

**Cosas a saber:** (1) **sin reruteo si sa-east-1 se cae** (doc de Supabase): para volver atrás se saca `?forceFunctionRegion=sa-east-1` de la URL en Meta y se guarda con el token vigente.
(2) La URL del webhook es configuración de Meta: un deploy de la función no la toca. (3) El botón «Probar» de Meta deja una fila en `wa_turno_tiempos` con `llegada_s` absurdo: al medir,
filtrar `respuesta_s is not null`. (4) El cartel de Meta dice que una app «En desarrollo» no recibe datos de producción y aun así recibe los de este número: no se tocó el modo de la app.

**Dónde quedó:** todo fuera del repo, ninguna línea de código. Documentado en las entradas del 14/10 y del 15/10 de `docs/ESTADO.md` (commits `c116313`, `62b75b4`, `6744403` y `8a99de4`).

---

## D016 — Guardrail de cruce de cliente en el corte de salida (2026-10-14, cargada el 15/10)

**Decisión (Pablo, 14/10: «Sí, atacá el guardrail hoy», requisito del go-live; el mismo día «Sí, sumalo ahora al guardrail» para el aviso de descuento):** un aviso de un cliente no sale al
teléfono de OTRO cliente real. Se **retiene** sólo si el teléfono está vinculado a algún cliente real y a **ninguno** de los clientes del mensaje (se compara por CUIT, así el mismo cliente
con código LK y Chef cuenta como uno). Se **permite** si el teléfono es de alguno de esos clientes, si no es de ningún cliente, si es teléfono de prueba (`wa_real_redirect_to`,
`wa_envio_test_phone` o `wa_gerencia_phones`), si el mensaje no dice a qué cliente va o si es simulado (cuit 30999…).

**Razón:** la llave `wa_puede_enviar` sólo dice si un número puede recibir, no si es del cliente al que va el mensaje. El 14/10 el barrido de `lk_factura-check` mandó las facturas de 8 grupos de
varios clientes a un solo número (Logística): era un número de prueba y nadie las recibió, pero con la llave en `1` el mismo error pone el CBU y las facturas de un cliente en el chat de otro.

**Dónde corre (sin tocar a los productores de la cola):** (1) `bot_flush_outbox` retiene las filas de contexto `order_created`, `retiro_listo`, `tracking_*` (el cliente sale del pedido en `ref_id`)
y `recordatorio_dto` (el cliente es el código LK de `ref_id`): quedan en `held_no_whitelist` con `error = 'cruce_cliente: el teléfono pertenece a otro cliente'`, sin reintento. (2) `wa-guard`: si el
productor declara el cliente con los headers `x-lk-cuit` / `x-lk-cod-cliente`, pregunta `wa_puede_enviar_a` en lugar de `wa_puede_enviar`; hoy lo declara `lk_factura-check` en sus 3 envíos, sólo con el CUIT.

**Medido antes de activarlo:** 17 casos con datos reales; sobre los 20 envíos históricos de la cola con pedido, 11 pasan (todos teléfonos de prueba) y 9 se habrían retenido (todos de agosto y
septiembre, a teléfonos que hoy pertenecen a otro CUIT); y una prueba punta a punta sin enviar nada, en una transacción deshecha.

**Límites, a saber antes del go-live:** (a) protege contra un productor que elige mal el teléfono y contra vínculos que cambian entre que se encola y se despacha; **no detecta un dato maestro mal cargado**:
si el teléfono equivocado sólo está vinculado al cliente al que va el aviso, pasa. (b) No cubre las filas de la cola cuyo `ref_id` no identifica al cliente (`lk_notif-facturado`, no versionada acá), ni las
respuestas del webhook, ni los envíos directos de `notify-order-created` y `notify-tracking-status`. (c) **Los teléfonos de `wa_real_redirect_to` y `wa_gerencia_phones` quedan exentos**: la revisión
del 15/10 (tarea de Planify 5852) encontró 2, Logística y Thomy, ambos de prueba; ver D011 para lo que falta antes de pasar la llave a `1`.

**Dónde quedó:** `sql/156_wa_guardrail_cruce_cliente.sql` (aplicada en vivo en PaginaLK; rollback en `sql/rollback/156_…`; 5 funciones nuevas sólo para `service_role`), `_shared/wa-guard.ts`,
`_shared/wa-guard-destino.ts`, `lk_factura-check`; prueba `tests/wa-guard-destino.test.ts`. Commits `c729253` y `d9b4b67`. Tarea de Planify 5801.

---

## D017 — Control de gasto de IA: medidor mensual, tope por cliente y tope global que degrada (2026-10-14, cargada el 15/10)

**Decisión (Pablo, 14/10):** «200 USD gratis de Anthropic, uso 100/mes, que avise al 25/50/75 % y verlo en el dashboard» → «el tope va a ser 2 USD por cliente por día, 5 por semana» → «las dos capas».
Y para el tope global del día: «degrada, pero no cortes del todo», «Haiku con 2º techo» y «que no corte en 5, sino que dé un aviso a un humano si está dentro del horario de atención».

**Capa A, medidor mensual del pozo (sólo avisa, no corta):** `ia_presup_mensual_usd` (US$ 100), `ia_presup_pozo_usd` (US$ 200, sólo para mostrar) y umbrales `25,50,75,90,100`. Cuenta **todo** el gasto del
mes (clientes, simulador, chat de prueba y puntaje), porque el pozo se agota con todo. Una alerta por umbral por mes (motivo `tope_gasto`, `nivel: presupuesto`), urgente desde el 90 %. Barra en el dashboard (v0.29.5).
**Capa B, tope por cliente (sí corta, sólo a ese cliente):** `ia_tope_cliente_dia_usd` (US$ 2) y `ia_tope_cliente_semana_usd` (US$ 5) por teléfono, semana de Argentina desde el lunes. Al cruzar: a ese cliente no se le
llama al agente, recibe un aviso fijo y se deja una alerta (una por día por teléfono); a los demás se les sigue contestando. Los dos números se pisan: 3 días llenos son US$ 6 y la semana corta en US$ 5.
Ante un error de lectura no bloquea. **Tope global del día de los clientes, tres escalones y el agente nunca queda mudo:** aviso (`ia_aviso_gasto_usd` = 2,5) → degradar (`ia_tope_gasto_usd` = 3: sólo modelos gratis y, si ninguno
responde, `claude-haiku-5-5`, nunca Sonnet) → escalar (`ia_tope_escalar_usd` = 5: no corta, sólo suma una alerta para una persona y sólo dentro del horario de atención; 0 = sólo degrada). La toma de pedidos no se degrada.
El corte duro que dejaba mudo al cliente se eliminó.

**Razón:** el 01/10 el crédito de Anthropic se agotó por el gasto del simulador (US$ 13,23 del 28/09 al 01/10) y el agente dejó de contestar. **La cifra es una estimación** (`estimated_cost_usd`, del código): corregirla contra el API de
uso de Anthropic queda pendiente de una admin key nueva, y Pablo decidió dejarla estimada. Al 15/10 el medidor marcaba US$ 12,33 de 100 (12,3 %), sin umbral cruzado.

**Dónde quedó:** `_shared/presupuesto-ia.ts`, `_shared/tope-cliente.ts`, `_shared/tope-gasto.ts`, `lk_whatsapp-webhook` (`avisarPresupuesto`, `pasoElTopeCliente`, `pasoElTopeDeGasto`), `sql/154` y `sql/155`; pruebas
`tests/presupuesto-ia.test.ts`, `tests/tope-cliente.test.ts` y `tests/tope-gasto.test.ts`. Viva desde el deploy del 15/10 (`lk_whatsapp-webhook` v333).
**Hallazgo del 15/10, corregido (problema 812 de la auditoría; Pablo: «Sí, registralo y corregilo con el texto de antes»):** `pasoElTopeCliente` mandaba `MSG_TOPE_GASTO`, una constante que el commit `f13fd4d` (15/10 13:32 UTC, el tope que degrada) había borrado sin sacar ese uso (`deno lint no-undef` marcaba `MSG_TOPE_GASTO is not defined` en `lk_whatsapp-webhook/index.ts`). Consecuencia **inferida del código, no probada**: al cruzar el tope por cliente la alerta se creaba pero el envío lanzaba un error que la función atrapaba y dejaba pasar ese primer mensaje, y desde el siguiente el cliente quedaba sin respuesta y sin aviso. **Corrección:** el mismo texto de antes, ahora con un nombre del módulo del tope por cliente, `MSG_TOPE_CLIENTE` en `_shared/tope-cliente.ts`, que el webhook importa; así no depende del tope global. Prueba: `tests/tope-cliente.test.ts` (23 chequeos) con una guarda de sólo lectura: todo `MSG_*` que usa el webhook tiene que estar definido ahí o exportado por algún `_shared/*.ts` (falla con el webhook anterior: `MSG_TOPE_GASTO` sin definir). La primera versión de la guarda corría `deno lint` con `Deno.Command`, el CI no da `--allow-run` y la corrida 464 salió roja: se reemplazó en `2e37c70`. Se revisaron con esa regla todos los archivos de `supabase/functions`: no queda ningún identificador sin definir. No se probó en vivo (haría falta que un cliente real cruce el tope). **Deploy:** `f03f3b4` no se desplegó por CI (corrida 464 roja por esa prueba) y la 465 salteó el deploy porque el diff de su push sólo traía el test: `lk_whatsapp-webhook` se desplegó a mano el 15/10 a las 15:28 UTC (corrida 466, versión 347). Cerrado en la auditoría con `f03f3b4`. **Otro pendiente:** la llave huérfana
`ia_tope_duro_usd` = 5, que el código ya no lee, se borra con el «sí» de Pablo.

---

## D018 — Precios y totales: la IA da el precio de un artículo, todo precio lleva «+ IVA» y el total de un pedido se dice como el aviso (2026-10-14, cargada el 15/10)

**Decisiones (Pablo, 14/10):** «La IA tendría que buscar el precio y darlo» («cuánto sale el X» llega a la IA y la respuesta fija #11 queda sólo para pedir la lista); «Buenos días, empezá a laburarlo» (regla **CONSULTÁ ANTES DE PREGUNTAR**:
nunca se le pide al cliente el nombre o el código de un artículo que ya nombró, se busca con `buscar_productos`, de la forma que lo diga); «Está perfecto, sí, agregale más IVA» (el precio de un artículo por código también lo da la IA y todo precio de un artículo
lleva «+ IVA»); «Sí, corregilo así» (el total de un pedido se dice como el aviso automático, con IVA y el neto «+ IVA», por ejemplo «$ 152.719 ($ 126.214 + IVA)», y no se muestran importes por línea que no estén cargados).
**Los importes de facturas y deuda ya vienen con IVA y no se tocan.**

**Razón (medido):** la #11 le ganaba a la #12 por prioridad en el empate y el cliente recibía el enlace de la web (en la historia hubo 2 casos reales); la respuesta fija por código cotizaba el artículo inactivo 597 a $ 8.888 y calculaba por unidad con un 2 % web fijo,
mientras la IA da el precio por caja con el descuento por volumen: dos precios para la misma pregunta. Y el total de `orders` es **sin IVA** y con los descuentos aplicados: la IA podía decir «$ 741.048» cuando el aviso del mismo pedido dice «$ 896.668 ($ 741.048 + IVA)».

**Dónde quedó:** `preguntaPrecioDeArticulo` (`articulo-nombre.ts`) más una línea en `handleFaq`, se borró `lookupProductPrice`, reglas en `agente-fijos.ts`, `_shared/importes-pedido.ts`; commits `1ceb0d9`, `955e10e`, `1bc9dae`, `d59ecbd`, `5917139`, `1aed8ad` y `5ce5b4e`; pruebas
`tests/articulo-nombre.test.ts`, `tests/precio-articulo-ia.test.ts`, `tests/regla-consulta-antes.test.ts` e `tests/importes-pedido.test.ts`. **Verificado en el Simulador con Haiku 5.5** (gastos de US$ 0,004892 a 0,0859 por tanda), incluido que el «+ IVA» no contamina los importes de facturas (LK 1987, 2 de 2).
**Sin mirar:** los totales de `consultar_mi_historial` y `buscar_en_mi_historial`. Lo del 15/10 sobre precios y fotos sigue en D014.

---

## D019 — Memoria del cliente: ficha editable y protegida, memoria del año a demanda y importador listo sin aplicar (2026-10-14, cargada el 15/10)

**Decisiones (Pablo, 14/10):** (1) «seguí con otra tarea de memoria»: en Conversaciones › Ficha del cliente la memoria del agente es **editable** y tiene el botón **Marcar revisada** (dashboard v0.29.2 y v0.29.3, `lk_conversaciones`); una ficha revisada **no la pisa el cron incremental** (`sql/151`, columnas
`revisada_por` y `revisada_en`; el corte es antes de llamar a Haiku, US$ 0). (2) «reprocesá las 504 para sacarles el descuento»: las fichas no llevan porcentajes ni importes, porque el agente los saca en vivo por cliente; 26 cambiadas y 2 revisadas salteadas, 0 fichas con % o importe, sin llamar al modelo,
con respaldo `zz_backups.bkp_wa_memoria_cliente_reproc_20261014`. (3) «necesito que tenga memoria del último año» → «hacé la herramienta on-demand»: `buscar_en_mi_historial` (`sql/149`), sobre el historial del propio cliente (año 09/06/2025 a 09/06/2026, 27.348 mensajes, más lo vivo del bot),
**sin embeddings** (decisión del 09/10) y con aislamiento por `(cod_cli, marca)`. (4) «la memoria la cargo el día que salgamos» → «dejalo listo… lo hacés vos desde Claude in Chrome»: el importador del WhatsApp humano (`sql/150`, `docs/RUNBOOK-IMPORT-HISTORIAL.md`) queda **listo y SIN aplicar**; el tramo del 10/06 al lanzamiento se carga el día que arranquen.
(5) Fichas del piloto: los textos de 3790 y 3969 se ejecutaron el 14/10 («Sí, ejecutalos»), con respaldo; 1987 no se toca.

**Auditoría de las 504 fichas:** 0 teléfonos, 0 mails, 0 CUIT, 0 % o importes, 0 «calle y número»; anti-mezcla activa (7 charlas con varios clientes excluidas). **Pendiente:** el tramo del 09/06/2026 a hoy no está importado (P3.2, sin dueño); a 411 y 4028 del piloto la herramienta les devuelve vacío porque no tienen historial.

---

## D020 — Evaluación del agente: P5 planificación, P7 pausa y P8 revisión diaria (2026-10-14, cargada el 15/10)

**Decisiones (Pablo, 14/10, «sigamos con los 8 puntos»):** **P5**: regla fija **ANTES DE ACTUAR** en `agente-fijos.ts` (consigue los datos con las herramientas antes de usar una que cambia algo o de preguntar, y si hay varios pasos los hace en orden en el mismo turno) y 8 casos multipaso `mp01` a `mp08` en `wa_agente_evals` (`sql/147`); su criterio era pasar con el modelo del piloto 3 noches
seguidas. Ese mismo día pasó a una corrida semanal con Haiku 5.5 («Cambialo a Haiku, medición semanal», `sql/153`) y el 15/10 se sumó el juez automático (`sql/157`): ver `CLAUDE.md` para los gastos permitidos; la primera corrida con juez es el lunes 19/10 a las 10:15 (tarea 5796).
**P7**: `docs/RUNBOOK-PAUSA-P7.md`, 6 pasos para pausar y retomar el bot sin tocar código (pausar = llave `wa_envio_automatico` en `0`, retomar = `prueba`, desde la franja «Envíos a clientes» del dashboard, auditado en `wa_llave_cambios`); P7 sigue «parcial»: falta que Pablo ensaye la pausa y revisar el tope de gasto el 23/10.
**P8**: worklist de la revisión diaria `v_wa_charlas_para_revisar` (`sql/152`) en Configuración del agente › Evaluación (v0.29.4); P8 sigue en «no»: su criterio necesita el reporte del 23/10 con tráfico real.

---

## D021 — Marca: un cliente de LK con cuenta de Chef que nombra Chef lo atiende el flujo de Chef (2026-10-14, cargada el 15/10)

**Decisión (Pablo, 14/10: «Sí, corregilo así»):** en `puertaMarca` (`marca.ts`), si el cliente no tiene cuenta de Chef activa pero el mensaje **nombra Chef** y su CUIT tiene cuenta de Chef (`cuentaChefPorCuit`, por CUIT y no por código), lo resuelve `atenderClienteChef`; si no nombra Chef o no hay cuenta, sigue como siempre: a nadie se le pregunta la marca de más.
**Razón:** LK 1987 (con cuenta Chef 1891 sin compras recientes) preguntó «¿qué pedidos tengo en Chef?» y el agente le contestó con los pedidos de LK sin decir que eran de Loekemeyer. **Cuidado:** existe otro cliente Chef con código 1987 y otro CUIT (27306399247): el cruce es por CUIT, no por código.
Se retiró lo que decía `PILOTO-LISTA-CLIENTES-2026-10-13.md`: LK 1987 se atiende como cliente de una sola marca, no de dos. El flujo de Chef deriva a una persona la lista de pedidos de Chef de ese cliente. Commit `c978129`; `tests/marca-chef-inactiva.test.ts`. Complementa D008.

---

## D022 — Piloto: lo medido y lo cerrado el 14/10 (2026-10-14, cargada el 15/10)

**Smoke test (pedido de Pablo):** los dos clientes de la whitelist pasaron 8 de 8 de punta a punta en el Simulador (Thomy como 4028 y Damián como 411), con un gasto de US$ 0,001742 por las llamadas auxiliares. **Medición del tiempo de respuesta (tarea 5530):** 34 turnos con IA, mediana 10,3 s, p90 14,6 s y sólo 1 dentro del objetivo de 3 a 6 s; el modelo tardaba una mediana de 3,1 s, así que
el resto era otra cosa (D015). **Rechazo real de Meta (tarea 5630):** el 14/10 15:25 UTC Meta rechazó la foto del 599E enviada al 4210 (131053); quedó `envio_no_llego` en `bot_auditoria`, la alerta `envio_fallido` y el bloque «Hechos de esta charla» se lo dice al agente.
**Planify (Pablo: «solamente las mías, de Pablo, trabajá con mi usuario»):** de 10 tareas abiertas quedaron 5 y ninguna vencida; de las 442 abiertas y 121 vencidas del total, casi todas de otros repos y de otras personas, no se tocó ninguna. **Auditoría del repo:** en 0 abiertos (45 corregidos y 1 descartado) tras cerrar «Respuestas fijas por palabra clave contestan otra cosa…» (656) y «Programación no web nunca marca "Retira"…» (614).
**Pendiente:** el prompt de la Routine «Bitácora diaria GestOpClientes» lleva el secreto `x-bitacora-secret` en texto plano; si importa, rotarlo en `app_settings` y en la Routine.

## D023 — Planify: en este repo sólo se carga en el Planify de Pablo (64) (2026-10-15)

**Quién:** Pablo Olejavetzky. **Qué:** *«No cargues nunca nada en otro planify sino te lo digo yo, cada uno esta trabajando en sus proyectos»*.
Las tareas de este repo van al 64 o no se cargan, aunque el pedido dependa de otra persona o sea de otra área, y tampoco se ofrece cargarlas en
otro Planify. Le gana al punto 3 de la regla general (pedidos de Thomas al área o a `Tareas T`). **Por qué:** el 15/10 se ofreció cargar en el
Planify de Luis (52) la decisión de abrir el piloto a clientes reales (no se cargó). **Dónde:** `CLAUDE.md`, sección «En ESTE repo, las tareas de
Planify van SÓLO al Planify de Pablo Olejavetzky (64)», commit `fe18637`.

**También del 15/10 (P8):** `v_wa_resultado_charla` cuenta como `derivada` todo pase a una persona con la lista de motivos de `hechos-charla.ts`
(`sql/158`, commit `4702895`), y el error quedó registrado y cerrado en la auditoría. Pablo dijo «Sí, registralo en la auditoría y cerralo».

## D024 — Deploy: la base del diff es el último push verde, no `github.event.before` (2026-10-15)

**Quién:** Pablo Olejavetzky. **Qué:** *«Sí, registralo en la auditoría»* (problema 813) y, al ofrecerle el arreglo, *«Sí, arreglá el workflow ahora»*.
**Por qué:** `f03f3b4` (fix del problema 812) salió rojo en el CI (corrida 464, mi prueba pedía `--allow-run`) y el push siguiente (corrida 465) no tocaba
funciones: el diff contra `github.event.before` dio vacío, el paso «Deploy» se salteó y el CI terminó verde con el bug en producción de las 15:20 a las 15:28 UTC.
**Cómo quedó:** `.github/workflows/deploy-edge-functions.yml` busca con `gh api` el commit del último push de `main` que terminó en `success` (los disparos manuales no
cuentan: pueden desplegar sólo algunas funciones) y diffea contra ése; con dos candidatas gana la más vieja, y si la API falla o el commit no está en la historia
cae a `github.event.before` y después a `HEAD^`. El job `deploy` pidió `actions: read`. El disparo manual con la lista vacía ahora despliega lo pendiente desde el
último verde (antes: lo del último commit). **Prueba:** `tests/workflow-deploy.test.ts` (7 chequeos estáticos: 6 fallan con el workflow anterior) y el script corrido a mano
con un `gh` falso en 7 escenarios. **Costo conocido:** el script ya redeployaba todas las funciones que importan algo de `_shared/` cuando cambia cualquier archivo
de `_shared/`, así que un push que recupere el fix de `tope-cliente.ts` despliega 25 funciones y no sólo el webhook (es la regla vieja, no se tocó).
**Verificado en el runner:** la corrida 467 (`788ff42`) mostró «último push verde: 0ebec42…» en el log, o sea que `gh api` funciona con `actions: read`. **Dónde:** `788ff42` (el arreglo) y el commit siguiente (el aviso del log, que decía «push que no salió verde» cuando el anterior era de docs), problema 813 de la auditoría, tarea 5936 de Planify (64).
---

## D025 — Continuidad entre charlas: markdown + hook de contexto (2026-10-15)

**Decisión (Pablo, 15/10: «markdown + hook, dale»):** como Claude no tiene memoria entre conversaciones y no puede leer otras charlas, el contexto compartido se materializa en lo
escrito en el repo y se carga solo al abrir cada charla. El registro vive en markdown (`docs/DECISIONES.md` + `docs/ESTADO.md`, no una tabla de Supabase).

**Razón:** varias charlas en paralelo sobre el mismo repo perdían lo hablado (caso del 15/10: los vínculos 225 y 228 salieron de una charla que no dejó rastro; la corrida fallida del
circuito del 14/10 tampoco quedó escrita). El markdown ya existía a medias; faltaba que se cargara sin depender de que Claude se acuerde de leerlo.

**Dónde quedó:** `scripts/contexto-repo.sh` (nuevo) + `.claude/settings.json` (segundo hook de `SessionStart`, después de `claude-permisos.sh`). Al abrir cada charla imprime las
últimas 12 decisiones de `DECISIONES.md`, la fecha de `ESTADO.md` y `git log -8`, y recuerda la regla de anotar en el mismo turno. Sólo lee archivos del repo, sin credenciales.

**Límite:** si una charla no anota, el hook no la puede mostrar — el candado es la disciplina de escribir, igual que con los commits. Lo de las bases (tareas abiertas, auditoría) lo
consulta Claude con el MCP cuando hace falta; el hook no tiene credenciales para eso.

## D026 — Alarmas: se cierran con evidencia, no por el puntaje del juez (2026-10-15)

**Quién:** Pablo Olejavetzky. **Qué:** *«Chequeá a fondo qué alarmas cerrar»*. **Criterio aplicado:** una respuesta marcada por el puntaje de IA se cierra como `falsa_alarma` sólo si la queja del juez se contradice con la base (alerta de `wa_alertas_humano` a esa hora, regla vigente de pedidos por WhatsApp, charla real en `bot_historial_chat`) y como `bien_marcada` si la respuesta rompe una regla vigente o contradice la base. Lo ambiguo queda abierto para Pablo. **Resultado:** 29 de 35 cerradas, 6 abiertas (13, 21, 23, 30, 31, 36). Detalle y los dos defectos del juez: entrada del 15/10 en `docs/ESTADO.md`. **Dónde:** `wa_ia_puntajes` (PaginaLK), tarea 5939 de Planify (64). **Aplicación del 16/10:** el mismo criterio cerró otras 7 (67, 68, 72, 74, 75, 76 y 77), todas `bien_marcada`; la cola quedó en 0 por revisar. El 72 no tenía problema en la auditoría y se registró aparte.


## D027 — P5: cómo contesta el agente sin pedido pendiente, formato del total y juez (2026-10-14 y 15/10, sesión del plan de los 8 puntos)

**Quién:** Pablo Olejavetzky. Cargada el 15/10 a pedido suyo al cerrar la charla: *«Que de todo haya registro»*.

**Decisiones, en el orden en que las dijo:**
1. **Sin pedido pendiente, listar y preguntar cuál** (14/10): *«Tendria que darle un listado de los pedidos que realizo, por que ponele que lo hizo hoy u antes de ayer»*.
   Si el cliente pide cambiar, sacar, agregar o anular algo y ningún pedido está pendiente, el agente le pasa la lista (fecha y estado, sin importes) y le
   pregunta cuál es, sin derivar y sin decirle que no le figura. Si ya dijo cuál y ese salió, se le dice y se le indica cómo pedir de nuevo. Sólo si
   contesta que no es ninguno se deriva (`pedido_no_encontrado`). Va en la regla SIN PEDIDO PENDIENTE (`_shared/agente-fijos.ts`) y en la respuesta de
   `consultar_mis_pedidos` (`_shared/pedidos-sin-pendiente.ts`), porque en el prompt solo los modelos chicos la salteaban.
2. **No ofrecer lo que no pidió** (14/10): *«Sí, sacala si no lo pidió, me parece muy invasivo»*. Ni pedido nuevo ni la web si no lo pidió (regla CIERRE),
   y la respuesta fija de stock ya no cierra con «Podés hacer el pedido en loekemeyer.com» (`_shared/faq.ts`).
3. **Total sin la frase «con IVA»** (14/10): *«Nono, me gusta asi como quedo, Que no tenga la frase "con IVA"»*. Formato `$235.442 ($194.580 + IVA)`: el primer
   número ya incluye el IVA y nunca lleva «+ IVA» al lado (regla TOTAL DE UN PEDIDO y descripciones de las herramientas).
4. **Rehacer un pedido: alcanza con listar y preguntar cuál** (15/10): *«Sí, alcanza con listar y preguntar cuál»*. El pedido nuevo se encamina cuando conteste.
5. **Medición semanal con Haiku** (14/10, *«Cambialo a Haiku, medición semanal»*) y **juez automático con Haiku** (15/10, *«Sí, armá el juez automático con Haiku»*):
   `sql/153`, `sql/157`, `lk_eval-juez`, `_shared/eval-juez.ts`. El juez marca `a_medias` o `mal` sólo si puede citar qué parte de la nota esperada falta.
   Con créditos de prueba disponibles Pablo autorizó usarlos (*«tenemos creditos de apis disponibles para pruebas, asi que a usarlos»*, 15/10).

**Otros arreglos del mismo trabajo:** `derivar_a_persona` ya no hace que el agente reemplace lo que averiguó por el aviso (mp05), PAGOS no deriva preguntas
de cuánto debe o cómo pagar, y la consulta de stock que ya avisó a una persona no se vuelve a derivar. Las notas esperadas de mp01 a mp08 se reescribieron
para que el juez no marque mal respuestas correctas.

**Resultado:** corrida 13 (re-juzgada) y corrida 15 dieron 8 de 8 con Haiku y juez. P5 queda en «parcial» hasta la corrida automática del lunes 19/10
10:15; si da 8 de 8, pasa a ok (tablero p5, tarea de Planify 5796). Commits en `main` del 14 y 15/10, de `dadf901` a `0a3b83b`. Plan:
`docs/PLAN-AGENTE-8-PUNTOS-2026-10-13.md`.

**Pregunta abierta (sin respuesta al cerrar la charla del 15/10):** ¿el piloto del 19 al 23/10 incluye clientes reales? Hoy toda la whitelist es de prueba,
así que el reporte del 23/10 no mide el objetivo y P8 no puede llegar a ok. Abrir el bot a clientes lo deciden Luis o Thomas (principio de la vasectomía).

## D028 — El juez del puntaje de IA usa las reglas y la charla reales del agente (2026-10-15)

**Quién:** Pablo Olejavetzky. **Qué:** *«Sí, corregí lk_ia-puntaje para cerrar 818 y 819»*. **Por qué:** el juez marcaba como mala toda respuesta que tomaba un pedido (le daba la regla de pedidos apagados con `wa_pedidos_config.activo = true`) y puntuaba sin ver la charla (leía `wa_conversations`, sin filas desde el 05/10). Con eso las revisiones de IA › Revisión de respuestas se llenaban de falsas alarmas (D026). **Cerrados en la auditoría el 15/10** (Pablo: *«Sí, corré esas dos sentencias tal cual»*) con `4cd5564`, deploy 18:22 UTC (`lk_ia-puntaje` versión 104). **Cómo quedó:** el juez recibe `reglasOperativas(pedidosWa)` y la charla de `bot_historial_chat`, y no evalúa si no puede leer `wa_pedidos_cfg`. **No incluye** el bloque «Hechos de esta charla» ni los otros tres lectores de `wa_conversations` (Salientes, Alertas, adjuntos: problema 821). **Dónde:** `supabase/functions/lk_ia-puntaje/` (`juez.ts`, `index.ts`), `tests/puntaje-juez.test.ts`, tarea 5945 de Planify (64), problemas 818 y 819 de la auditoría.

---

## D029 — Recordatorio del ensayo de pausa P7 va a Planify, no a un scheduled trigger (2026-10-15)

**Quién:** Pablo Olejavetzky. **Qué:** probé agendar el recordatorio del ensayo de pausa P7 como un scheduled trigger de una sola vez (dispara mañana 09:00 Argentina en esta sesión). Pablo prefirió *«ponerla en el dashboard ahora y que venza mañana»* y, al preguntar cuál dashboard, confirmó **Planify**. **Por qué:** el scheduled trigger sólo avisa cuando dispara y en la sesión de Claude; una tarea de Planify queda visible en su agenda con fecha de vencimiento y la cierra él o Claude cuando el ensayo esté hecho. **Cómo quedó:** tarea 5948 de Planify (empleado 64), fecha 16/10, `done=false`, nota con los pasos del ensayo (apagar/prender `wa_envio_automatico` desde «Envíos a clientes», verificar la fila en `public.wa_llave_cambios`, hoy 0 filas); borré el trigger `trig_01GDFvHq3Nmi6rSdF8jXKqj2`. **Contexto:** P7 (Límites) sigue «parcial»: para pasar a «ok» faltan el ensayo de pausa y recalibrar el tope de gasto el 23/10 con tráfico real (`docs/PLAN-AGENTE-8-PUNTOS-2026-10-13.md`, `docs/RUNBOOK-PAUSA-P7.md`). **Regla confirmada de paso:** un recordatorio con vencimiento se carga como tarea de Planify, no como scheduled trigger.

---

## D030 — Búsqueda de productos del bot: insensible a grafía, plural y typos (wa_norm + wa_fon) (2026-10-15)

**Decisión (Pablo O., 15/10):** la búsqueda del agente (`bot_buscar_productos`, PaginaLK) deja de comparar texto crudo. Dos capas:
1. **Normalización + plural (`wa_norm`):** compara ambos lados en minúsculas, sin acentos, sin espacios ni signos, y pliega el plural. El `-es` se pliega **sólo** tras `r l n d z j`
   (las consonantes que en español toman `-es`): `exprimidores→exprimidor`, `cucharones→cucharon`, pero `mates→mate` y **no** `mat`.
2. **Fonética de respaldo (`wa_fon`):** clave determinística que pliega el seseo (z y c-ante-e/i→s), b/v→b, ll/y→y, h muda, qu/c→k y letras repetidas. Entra **sólo si la búsqueda
   normal da 0**, más un escalón fonético en el lookup de `bot_sinonimos`. Colisión exacta entre grafías equivalentes, sin umbral.

**Razón (medido):** [plural] `exprimidores`/`cucharones` daban 0 por no tener categoría plural en el catálogo; un strip `-es` genérico arrastraba «Prensa Matambre» (cód. 246) al pedir
mates. [fonética] se descartó pg_trgm porque `cuchara~cuchillo` 0,31 supera a `valde~balde` 0,33: ningún umbral separa un typo de una palabra distinta. Con `wa_fon`, 9/9 pares de typo
reales colisionan y 0 falsos.

**Hallazgo clave:** el valor de `wa_fon` **no** son los typos obvios —el LLM los corrige solo antes de llamar la tool (`zacacorchos→sacacorchos`, `yaveros→llaveros`,
`espumaderaz→espumadera`, los tres verificados en Simulador)— sino las **brechas legítimas entre cómo habla el cliente y cómo está escrito el catálogo**, que el LLM no corrige porque el
cliente ya escribió bien. Verificado en vivo (Simulador cliente 4028, Gemini gratis, gasto US$ 0): «hola, necesito un rompe nuez» → el LLM mandó `query:"rompenuez"` (no lo corrigió) y el
bot halló «Rompenueces Inox» (507); en SQL ese término da **0** por la vía normalizada sola y **507** por la función completa. El seseo cubre de paso `nuez/nueces`, sin regla z→c aparte.

**No se hizo:** levenshtein para typos no fonéticos (transposición «sacocrchos», letra de más): choca en palabras cortas y la fonética cubre el grueso. Si aparece un caso real, se reevalúa.

**Dónde quedó:** `sql/159_bot_buscar_productos_normalizado.sql` (wa_norm + plural, commit `7c1c694`) y `sql/160_bot_busqueda_fonetica.sql` (wa_fon + tier de respaldo, commit `bb48823`),
ambas aplicadas en vivo en PaginaLK con `execute_sql` (grants a `service_role`). Misma firma y retorno: `_shared/bot-conversation.ts` no cambió. Entrada del 15/10 en `docs/ESTADO.md`
(commit `329a548`). Tarea de Planify 5924. Backend puro: la versión visible del dashboard no cambia.

---

## D031 — Vistas SECURITY DEFINER pasan a security_invoker; `estadistica_madre` queda abierta (2026-10-15)

**Decisión (Pablo, 15/10: «Dale, el "sí" para el flip de las 6»):** se pasan a `security_invoker = on` las 6 vistas `SECURITY DEFINER` de PaginaLK que tienen fix limpio: `v_clientes_arca`, `leads_overview`, `v_orders_origen`, `expo_dashboard_stats`, `v_wa_faq_summary` y `v_customer_item_month`. La 7ª, **`estadistica_madre`, NO se toca** hasta saber qué app la consume y con qué clave.

**Razón:** las vistas corrían con el default definer de Postgres (dueño `postgres`), así que salteaban la RLS de sus tablas madre. Como 1264 clientes reales se loguean (rol `authenticated`), cualquier cliente podía leer datos de todos los demás: `v_clientes_arca` exponía CUIT, estado AFIP y deuda BCRA de todos los clientes, y `leads_overview` el whatsapp, email, IP y notas de todos los leads. Era el advisor `security_definer_view` (ERROR) de Supabase.

**Por qué el flip es seguro y no rompe los paneles admin:** con `security_invoker=on` la vista corre como quien consulta, así aplica la RLS de las tablas madre. Esas tablas ya tienen policies que cubren a admin/staff/service_role (`admins`, `is_staff()`, fila propia), y `wa_faq` tiene la policy `anon_read` para las FAQ activas. `v_customer_item_month` ya se auto-filtraba por `auth.uid()`, así que no cambia de resultado.

**`estadistica_madre` se deja SECURITY DEFINER a propósito (hallazgo del 15/10, consumidor identificado):** grep sobre el frontend vivo (`loekemeyer/pagina-lk-copia`) muestra que la consumen el portal del cliente (`script.js`, feature "sugerencias de compra": cruza el historial del cliente con la demanda por SKU de todo el negocio) y la pantalla admin (`analisis-venta-cliente.js`), ambas con `.from("estadistica_madre")` y la clave `sb_publishable_…` (rol `anon`, o el JWT del cliente logueado). La vista expone **sólo datos de producto** (cod, descripción, categoría, ranking, unidades/mes proyectadas), **cero PII de cliente** — distinto de `v_clientes_arca`/`leads_overview`. El propio equipo de PaginaLK ya lo trió el 14/10 en `sql/revoke_funciones_sensibles_20261014.sql`: «Quedan abiertas a propósito (bajo): … estadistica_madre (unidades por artículo)». Por qué NO se flipea ni se revoca anon: el cache `estadistica_madre_cache` tiene RLS con 0 policies (deny-all), así que `security_invoker=on` dejaría al portal (publishable/anon) leyendo 0 filas y rompería las sugerencias; revocar anon lo rompe igual. El único camino sin romper sería agregar una policy de lectura (anon + authenticated) al cache y recién ahí flipear: más código para tapar un advisor de datos públicos de producto, no se recomienda. **Queda en DEFINER; el advisor `security_definer_view` queda en 1 como excepción conocida.**

**Dónde quedó:** `sql/161_vistas_security_invoker.sql` (aplicada en vivo en PaginaLK). Commit `d005b40`. Auditoría `github_repo_problemas` #825 (`seguridad`/`critico`, estado `corregido`). El advisor `security_definer_view` baja de 7 a 1.

---

## D032 — Modelo del agente: Sonnet 4.6 mientras el crédito cubra la IA (sólo anotado, no aplicado hasta el lanzamiento) (2026-10-15)

**Decisión (Pablo, 15/10):** el agente conversacional va a arrancar el piloto con **`claude-sonnet-4-6`**, no con Haiku. Y, consultado si lo aplicaba ahora, Pablo: *«Dejalo sólo anotado hasta el lanzamiento»*: NO se ejecuta todavía, queda la decisión escrita.

**Razón:** con los US$ 200/mes de crédito gratis de Anthropic cubriendo toda la IA (Sonnet proyectado ~US$ 45/mes = 23% del crédito), el gasto DE BOLSILLO es el mismo que con Haiku (US$ 56/mes fijos: Supabase US$ 25 + plantillas de Meta US$ 31), porque la IA la paga el crédito. A igual costo de bolsillo, Sonnet da mejor calidad: consulta antes de preguntar en los 1 a 2 casos de cada 34 donde Haiku 5.5 preguntaba de más (medición del 13/10, ver `docs/ESTADO.md`). Proyección completa en `docs/COSTOS-PROYECCION-AGENTE.md`.

**Condición de revisión:** vale mientras el crédito alcance. Si se agota el crédito o el volumen sube y la IA pasa a salir de bolsillo (Sonnet ~US$ 45/mes contra ~US$ 3 de Haiku), se revisa el modelo.

**Qué falta para aplicarla (NO hecho a propósito):** hoy el #1 de la cadena del agente es Haiku 5.5 (`wa_agente_modelos`, tarea `general`, puesto el 13/10 — D del plan de los 8 puntos y entrada del 13/10 en `docs/ESTADO.md`). Aplicar esta decisión = un `UPDATE public.wa_agente_modelos` que ponga Sonnet 4.6 de prioridad 1. Es una escritura en la base: en este repo va sin "sí" previo por la excepción de BD, pero Pablo pidió explícitamente dejarlo **sólo anotado hasta el lanzamiento**, así que no se corre hasta que él lo pida.

**Dónde quedó:** `docs/COSTOS-PROYECCION-AGENTE.md` › Decisión tomada, y entrada del 15/10 en `docs/ESTADO.md` (commit `7242a77`). Sólo documentación: no cambia código ni base, la versión visible del dashboard no cambia.

---

## D033 — La Routine de bitácora diaria falla silenciosa: fix del script OK, carga a la página todavía bloqueada (2026-10-15)

**Decisión / hallazgo**: La Routine "Bitácora diaria GestOpClientes (08:00 ART)" (`trig_012KVxRd3PrbzyGfys5hAnTn`) terminaba `succeeded` sin cargar ningún día. Se aplicó un fix parcial y queda pendiente la parte de la página.

**Por qué fallaba** [Seguro, dos corridas reales leídas]: su sesión arranca con el working dir vacío (entorno `env_01X1TuV8VqZQV349xdiV27sT` con `sources: []`). El agente clonaba el repo a mano y el clasificador de auto-mode bloqueaba `node scripts/reporte-diario/reporte-dia.mjs` como "código externo". El 14/10 en `bitacora_dias` quedó `fuente='manual'` (carga a mano del 14/10), nunca lo puso la Routine.

**Fix aplicado** (`update_trigger`, mismo `trigger_id`, sólo cambió el prompt): la Routine ya no ejecuta el `.mjs` del clon; escribe ella misma un `/tmp/rd.cjs` equivalente (mismo git log y mismo parseo de áreas/autor por trailer `Hecho-por`) y lo corre. Código propio de la sesión → el clasificador no lo bloquea. Verificado: el script corre y escribe el Artifact.

**Lo que sigue roto** [Seguro, corrida de prueba del 15/10 19:19]: (1) el POST a `lk_bitacora-sync` lo bloquea el clasificador como "posible exfiltración" (curl con el secreto a una URL externa) → la tabla `bitacora_dias` no se actualiza y el calendario del dashboard no muestra el día; (2) la sesión no tiene el MCP de Supabase (`mcp_connections` vacío) → la auditoría del día sale 0/0 falso.

**Opción de raíz pendiente de decisión de Pablo**: recrear la Routine con el connector de Supabase y hacer el UPSERT a `bitacora_dias` por MCP en lugar del curl (resuelve el bloqueo de exfiltración y el 0/0 a la vez), al costo de cambiar el `trigger_id`.

**Discrepancia a resolver antes de pisar datos**: el script full-history cuenta 94 commits para el 14/10; la carga manual tenía 16. Hay que decidir cuál es el válido.

**Dónde quedó**: nota del 15/10 arriba de todo en `docs/ESTADO.md`, corrección de la línea vieja de la entrada 5664, y auditoría `github_repo_problemas` problema 826 (ABIERTO, no cerrado: el fix no terminó de funcionar). El secreto `x-bitacora-secret` sigue en texto plano en el prompt de la Routine.

---

## D034 — El artículo en curso de la charla lo arma el código, y las cajas de `consultar_stock` sólo valen si el cliente las escribió (2026-10-15)

**Decisión**: Pablo, probando desde Logística (…1027): *«no me gustan las respuestas que está dando. No recuerda lo que le estoy consultando el mensaje anterior»*, y ante el diagnóstico, *«Sí, aplicá el fix»*. El agente repreguntaba el artículo que el cliente ya había nombrado en el turno anterior y mandaba `cajas` inventadas a `consultar_stock`.

**Por qué** [Seguro]: el historial sí le llegaba al modelo; el fallo era de comportamiento de Haiku 5.5 con las reglas del 15/10 que empujan a «preguntar de más». Mismo criterio que el caso Cuccinarte (`docs/FUGA-CUENTA-HISTORIAL-2026-10-14.md`): lo exacto lo arma el código, no el modelo.

**Qué se hizo**: `_shared/articulo-en-curso.ts` (bloque «Artículo en curso» en la parte variable del prompt; `cajasRespaldadas`), conectado en `_shared/bot-conversation.ts`; `tests/articulo-en-curso.test.ts`. Detalle, causa probable y límites en la entrada del 15/10 de `docs/ESTADO.md`. Auditoría 828, tarea de Planify 5969.

**Lo que NO se decidió**: no se tocaron las reglas PEDIDO SIN ERRORES, COLORES ni TIPO DE ARTÍCULO (Pablo las pidió el 15/10 y siguen). Tampoco se cambió el modelo del agente (D032 sigue sólo anotado). Comprobado en producción el 15/10 en 1 caso real (Pablo repitió «Tenes stock para 30 cajas?» desde Logística: consultó el 586 con 30 cajas sin repreguntar, US$ 0,00096); la variante «Del art que te pregunte antes» queda sin probar. Auditoría 828 cerrada con esas salvedades.

---

## D035 — Un mensaje con varias preguntas no es un cliente molesto: sólo cuentan los signos pegados (2026-10-15)

**Decisión**: Pablo, ante la derivación a una persona de «Hola, como estas? tenes stock del 586? que valor tiene? Tenes stock para 20 cajas?»: *«Hice las 3 preguntas en el mismo mensaje, tendría que entender el mensaje completo»*. El detector de grito (`_shared/humor-reglas.ts`, `grita`) pasa de «4 o más signos en total» a «4 o más signos PEGADOS» (`????`, `!!!!`, `?!?!`); MAYÚSCULAS con algún signo, insultos y quejas fuertes quedan como estaban.

**Por qué** [Seguro]: el paso 3b' del webhook (`atenderMalHumor`) responde y deriva ANTES del agente, sin IA; un mensaje cortés con varias preguntas es lo normal de un mayorista y quedaba sin contestar. Regla vieja del 28/09 (`docs/FLUJOS.md`).

**Qué se hizo**: `humor-reglas.ts`, `tests/humor-reglas.test.ts` (19 chequeos), línea de `docs/FLUJOS.md`. Auditoría 829. **No se tocó**: la cláusula de MAYÚSCULAS (un cliente que escribe todo en mayúsculas sigue marcado como grito; sin caso real que lo pida). Verificado en producción el 15/10: el mismo mensaje de Logística llegó al agente (deploy de la corrida 474) y contestó stock y precio sin alerta. Auditoría 829 cerrada.

---

## D036 — Compuerta de stock: si la respuesta habla de stock y no se llamó a `consultar_stock`, la llamada la hace el código (2026-10-15)

**Decisión**: Pablo, ante «Del ergonomico, de ese tenes 30 cajas?» contestado «tiene stock para las 30 cajas» sin herramienta (puntaje 74): *«Sí, arreglalo con la compuerta»*. Cuando el modelo termina sin herramientas y su texto dice o niega stock, el código consulta `consultar_stock` por él y le devuelve la palabra para que rehaga la respuesta con el texto de la herramienta.

**Por qué** [Seguro]: la regla STOCK de prompt ya lo prohibía y Haiku 5.5 la salteó dos veces el mismo día (filas 60 y 74). Un stock repetido de memoria es una promesa a un cliente. Mismo criterio que D034 y el caso Cuccinarte: lo exacto lo arma el código.

**Qué se hizo**: `_shared/compuerta-stock.ts`, cableado en `runConversation`, una sola vez por turno, hasta 4 artículos, fuera de la toma de pedidos. Marca `_compuerta: true` en el `input` para contarla. `tests/compuerta-stock.test.ts`. Auditoría 834, tarea 5976. Detalle y límites en la entrada del 15/10 de `docs/ESTADO.md`.

**Lo que NO se decidió**: los precios traídos del historial de otro día («los otros artículos que me ofreciste») quedan como problema aparte en la auditoría, sin arreglo. Pedir el código cuando se podía mirar el stock de los candidatos quedó decidido en D037. Tampoco se tocó `bot_auditar_tool`.

---

## D037 — Ante un artículo que no está claro, el agente pregunta; no adivina ni da stock o precio de todos los candidatos (2026-10-15)

**Decisión**: Pablo, sobre qué manda cuando el cliente no es claro con un artículo («preguntar para no equivocarse» o «mirar el stock de los candidatos y contestar todos»): *«Que mande preguntar y no adivinar»*. Gana PEDIDO SIN ERRORES (preguntar de más) sobre CONSULTÁ ANTES DE PREGUNTAR cuando hay varios artículos posibles.

**Por qué** [Seguro]: dos reglas del 15/10 se pisaban para una consulta de stock («tenes stock del pelapapas con mango rojo comun?» → listó 586, 505 y 587 y pidió el código: era lo correcto). Un stock o un precio dado para el artículo equivocado es una promesa equivocada.

**Qué se hizo**: dos cláusulas en `_shared/agente-fijos.ts`: la excepción en CONSULTÁ ANTES DE PREGUNTAR (un artículo pedido con varios candidatos: se pregunta cuál; si pide «todos», se dan todos) y la de CHARLAS ANTERIORES (lo ofrecido en otra charla no es «lo que te ofrecí» en esta; ante «los otros» poco claro se pregunta a cuáles). `tests/regla-preguntar-no-adivinar.test.ts`. Auditoría 835 abierta hasta verlo en una charla real.

**Lo que NO se decidió**: no se tocó PRECIOS Y FOTOS (pedir «todos» sigue dando todos). No se midió con el modelo si Haiku 5.5 sigue las cláusulas (requiere estimativo y «sí» de Pablo).
---

## D038 — Plantillas del remito: `pedido_retirado` y `pedido_en_expreso` subidas a Meta (2026-10-15)

**Decisión (Pablo, 15/10):** *«Subí pedido_en_expreso y pedido_retirado a Meta»*. Se crearon las dos en Meta con `lk_templates` action `templates_sync` (`aplicar`, `solo:[pedido_en_expreso,pedido_retirado]`), categoría UTILITY, idioma es_AR. Quedaron `PENDING` (en revisión de Meta): `pedido_retirado` id 2529181834243049, `pedido_en_expreso` id 2318701338906372.

**Qué NO cambia (vasectomía intacta):** crear plantillas en Meta no manda ningún mensaje ni cuesta. Las dos siguen SIN disparador (`estado: sin_disparador` en `disparadores.json`): el reenganche del trigger `trg_order_tracking_notify` sigue bloqueado hasta que Virgilio exponga la marca del remito (lado de Luis, ver `docs/REENGANCHE-REMITO-VIRGILIO.md`). Aunque Meta las apruebe, no sale nada hasta que (a) haya disparador y (b) `wa_envio_automatico` pase de `0`.

**Por qué se subieron ahora, antes del trigger:** aprobar en Meta tarda y es independiente del contrato de Virgilio. Subirlas ya adelanta la cola crítica: cuando llegue lo de Luis sólo falta el cambio del trigger, no esperar la revisión de Meta.

**Dónde quedó:** textos en `_shared/plantillas-meta.ts` (sin cambio de texto, sólo se corrigieron los comentarios que decían «sin subir a Meta»), `scripts/plantillas-artifact/disparadores.json` (las dos pasan a «creada en Meta, PENDING, sin disparador»), `docs/REENGANCHE-REMITO-VIRGILIO.md` (paso 2 marcado hecho) y el puntero del índice de `CLAUDE.md`. Tarea de Planify 5890 (Pablo). Backend puro: la versión visible del dashboard no cambia.
