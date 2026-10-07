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
