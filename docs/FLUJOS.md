# Flujos conversacionales — BotWA-LK

## Flujo 1: Primer contacto (vinculación)

Desde sql/072 (25/09) un número nuevo **nunca** queda vinculado sólo por escribir un CUIT (el CUIT
es público). Tres caminos:

- **Número en el padrón de teléfonos de Gestión Virgilio** (`virgilio.whatsapp_clientes`, copiado a `wa_clientes_telefono`): el bot lo reconoce directo, sin preguntar.
- **Número nuevo + CUIT de un cliente** → queda **pendiente**; un admin lo aprueba o rechaza en el
  dashboard (Centro de mensajes › Tareas, o Panel de Control → Vinculaciones; edge `lk_vinculaciones`). El aviso de resultado se
  encola en `wa_outbox`. Si el cliente ya tenía principal, el nuevo entra como secundario y al
  principal se le avisa.
- **3 CUITs distintos en 24 h desde el mismo número** → `too_many_attempts`, se deriva a ventas.

```
CLIENTE: Hola
BOT: Todavía no te tengo registrado como cliente. ¿Me pasás tu CUIT…?
CLIENTE: 30-71234567-8
BOT: Encontré la cuenta de *Comercial Ejemplo S.R.L*. 👍
     Por seguridad, un asesor tiene que confirmar que este número es de la empresa
     antes de vincularlo. Te avisamos por acá apenas quede listo. 🙏
(admin aprueba en el dashboard)
BOT: Hola Comercial Ejemplo S.R.L, te escribimos de Loekemeyer.
     Ya vinculamos este número a tu cuenta: podés consultar tus pedidos, descuentos y fechas de entrega.
```

## Flujo 1c: Cliente que sólo le compra a Chef (01/10, sql/115-116, `_shared/chef.ts`)

Un solo número para Loekemeyer y Chef (D008). Si `wa_identify_customer` no encuentra un cliente de LK, el webhook
pregunta `bot_identificar_chef`: vinculación aprobada (`bot_chef_whatsapps`) o padrón de teléfonos de Gestión con
empresa (`bot_telefonos_empresa`), sólo si todo lo que hay para ese teléfono en las dos empresas es el mismo CUIT.
Un teléfono que es de un cliente de LK y de uno de Chef con otro CUIT no se reconoce: va a vinculación.

Al cliente de Chef el bot le contesta sin IA y nunca con datos de Loekemeyer:

| escribe | contesta | alerta |
|---|---|---|
| saludo | qué puede consultar por acá | — |
| gracias / ok / 👍 | "¡De nada!" | — |
| cuánto debo, saldo, facturas pendientes | facturas de Chef sin pagar (`GV_Cobranza_Deuda_Viva`, por CUIT), con el descuento de cada una si aplica, + datos de pago de Chef | `pago` (una abierta por número) |
| alias, CBU, cómo pago | datos de pago de Chef (ficha Empresas); sin cargar → "Cobranzas te los pasa" | `pago` si no están cargados |
| ¿recibieron el pago? (fase 3) | busca el recibo en `gv_cobranza_recibos` (empresa chef, sus cuentas de Chef): si hay uno de los últimos 7 días lo confirma | `pago` si no figura |
| ya pagué, te paso el comprobante | "Le paso a Cobranzas" | `pago` |
| mandame la factura (fase 3) | el PDF de `isis_ch.documentos` (bucket isis-ch) del último día facturado o de la fecha/mes que nombre, con el saldo y el descuento de la factura y los datos de pago de Chef | `pago` si Chef no tiene alias cargado |
| me facturaron dos veces (fase 3) | busca dos facturas de Chef del mismo importe en 15 días | `reclamo` siempre |
| ¿qué descuento tengo? (fase 3) | cada factura de Chef abierta con su descuento (`dto_cond` hasta `vence`) | — |
| ¿cuándo llega mi pedido? (01/10) | sus pedidos de Chef de los últimos 30 días con estado y fecha de salida (`pedidos-marca.ts`, vista `gv_pedido_web_estado_pagina` empresa chef); sin pedidos → "no veo pedidos de Chef en los últimos 30 días"; Gestión no responde → "le paso a una persona" | `entrega` si Gestión no respondió |
| cualquier otra cosa | "Te responde una persona del equipo" | `cliente_chef` (una cada 2 h; va a Planify) |

Un cliente de LK que además le compra a Chef (mismo CUIT) recibe lo mismo en las respuestas de pagos de LK: pago recibido, reenvío, factura duplicada y descuentos (#8) miran también Chef, y cada factura sale con los datos de pago de SU empresa.

Cliente molesto y adjuntos siguen el camino de siempre; la alerta lleva `empresa: CH`, el código de Chef y el CUIT.

**Vinculación:** si el CUIT no es de LK pero sí de Chef, queda una solicitud de Chef pendiente (antes arrancaba el
alta). Al aprobarla se carga en `bot_chef_whatsapps`, nunca en `bot_customer_whatsapps` (D008). En Vinculaciones y
en Tareas se ve "Chef" al lado del código.

## Flujo 1b: El cliente contesta un aviso automático (28/09)

Cada aviso (pedido recibido, programado, en viaje…) queda en el historial como
`[Aviso automático <plantilla> · pedido <id>]` + el texto que leyó el cliente (`lk_outbox-flush`).
Si lo último del historial es un aviso de las últimas 48 h, el webhook trata el mensaje como
respuesta (`_shared/respuesta-aviso.ts`), antes de las FAQ, sin gastar tokens:

Botones de respuesta rápida (30/09): "Necesito cambiar la fecha" (programado) y "No puedo ese día" (listo para
retirar) llegan como si el cliente hubiera escrito ese texto (`extractMessage` en `_shared/wa-api.ts`) y caen en la
fila de "Cambiar" de abajo.

| El cliente dice | Ejemplo | Responde |
|---|---|---|
| Cambiar / cancelar / reclamar | "no voy a estar", "cancelalo", "agregame…", "hay un error", botón "Necesito cambiar la fecha" / "No puedo ese día" | "Le paso tu pedido a un asesor…" + alerta en `wa_alertas_humano` (`respuesta_aviso_cambio`) |
| Cuándo llega | "¿a qué hora llega?", "¿cuándo sale?" | estado y fecha real del pedido (`bot_estado_pedidos_gv`) |
| Agradece / confirma (sólo eso) | "gracias", "ok", "buenísimo", 👍 | "¡Gracias a vos! Cualquier consulta sobre tu pedido del dd/mm, escribinos por acá." |
| Otra cosa | "¿tengo el pelapapas A en ese pedido?" | flujo normal (FAQ / agente), que ve el aviso en el historial |

**Respuesta al recordatorio de descuento (30/09, Pablo):** si lo último fue `pedido_recordatorio_descuento`, no se
usan las ramas de pedido (un "no puedo" o "error" ahí es de un pago). `responderRecordatorio` en `_shared/respuesta-aviso.ts`:

| El cliente dice | Ejemplo | Responde |
|---|---|---|
| Reclama el saldo | "hay un error en el monto", "ya lo había pagado" | "Le paso tu consulta sobre la factura del dd/mm a una persona…" + alerta `reclamo_saldo` |
| Ya pagó / manda comprobante | "ya transferí", "te mando el comprobante" | "¡Gracias! Si tenés el comprobante, mandalo por acá así lo registramos." |
| Posterga | "pago el lunes", "el 20/10", "más adelante" | con fecha: el descuento que tendría ese día y el monto; sin fecha: las fechas que le quedan |
| Agradece | "gracias", "ok" | "¡Gracias a vos! Cualquier consulta sobre tu factura del dd/mm, escribinos por acá." |
| Otra cosa | | flujo normal (FAQ / agente) |

**Pedidos por WhatsApp apagados (28/09, Pablo):** el agente no toma ni ofrece pedidos; los deriva a la
web loekemeyer.com → "Pedidos Mayorista". Sin la herramienta `enviar_pedido` (flag `PEDIDOS_POR_WHATSAPP`
en `_shared/bot-conversation.ts`) y con la regla fija en `agente-fijos.ts`. Stock "hay" cierra con
"Podés hacer el pedido en loekemeyer.com."

**Cliente molesto (28/09):** antes que cualquier otra respuesta, si el mensaje trae insultos, quejas
fuertes ("una vergüenza", "nadie me contesta", "estoy harto") o gritos (MAYÚSCULAS con signos, 4+ signos
de pregunta/exclamación), el bot contesta "Perdón por las molestias. Ya le paso tu mensaje a una persona
del equipo…" y crea una alerta urgente `cliente_molesto` (→ tarea 🔴 urgente en Planify). Si ya hay una
abierta de ese número en las últimas 2 h, no crea otra ("Ya le avisé a una persona del equipo…").
Sin IA: `_shared/humor.ts` + reglas en `_shared/humor-reglas.ts`.

**Urgencia de las alertas (28/09):** cada alerta guarda `contexto.urgente`. Urgente = cliente molesto,
cambio/cancelación de pedido, comprobante con error, o texto con apuro/problema ("urgente", "hoy mismo",
"no me llegó", "vino roto/incompleto", "me cobraron de más", "reclamo"). Lo urgente va siempre a Planify
con prioridad urgente; el resto, según `app_settings.wa_alertas_planify`, con prioridad normal. En el
dashboard: aviso "👤 N esperando a una persona" en la barra lateral de todas las páginas (urgentes 🔴
primero) y marca "urgente" en 🔔 Alertas.

**Pedido de cambio en cualquier momento (28/09):** aunque lo último NO sea un aviso, si el cliente
tiene un pedido abierto (no entregado según Gestión) y pide cambiar la fecha / cancelar
("reprogramar", "otro día", "recién el 4/10", o "no puedo / no llego" + fecha, día o retiro), el
webhook deriva antes de las FAQ: "Le paso tu pedido del dd/mm a un asesor para que coordine el cambio…"
+ alerta `respuesta_aviso_cambio` (→ tarea en Planify). `pedidoDeCambio` en `_shared/respuesta-aviso.ts`.

**Descuentos con fechas reales (30/09, Pablo):** la FAQ de descuentos (#8, `customer_discount`) suma el token
`{{descuentos_facturas}}`: las facturas abiertas del cliente (`GV_Cobranza_Deuda_Viva` de Gestión, agrupadas por
fecha + condición, las 3 más nuevas) con "Pagando hasta el mié 14/10: 25% → pagás $X" para cada escalón que todavía
no venció (factura + días del escalón, corridos, al hábil: misma cuenta que el WhatsApp de la factura). Si eligió
e-cheq, le reclama el envío (fecha del cheque y monto). "NN FF" / "Sin Cotizador": sólo el saldo. Sin facturas
abiertas responde "no tenés facturas con saldo pendiente" (si falla la lectura, la línea no sale). Código: `descuentosFacturasBlock` en `_shared/faq.ts`.

**Reenvío de factura (30/09, Pablo):** la FAQ #10 ("no me llegó la factura", `factura_reenvio`) manda el PDF de las
facturas del último día facturado (o de la fecha "28/09" o el mes "julio" que nombre), de `isis_lk.documentos` / bucket
`isis-lk` de Gestión, como documento suelto (el cliente acaba de escribir: dentro de las 24 h; pasa por wa-guard). Si
la factura sigue con saldo agrega "💰 Si la pagás hoy tenés X% de descuento: pagás $Y (vale hasta el …)" o el reclamo
del e-cheq, y alias/CBU; sin saldo, "✅ Ya figura pagada". Sin facturas / sin PDF / error: deriva a una persona
(alerta `factura_no_encontrada` / `factura_sin_pdf` / `factura_error`). Código: `lookupFacturaReenvio` en `_shared/faq.ts`.

**FAQ (28/09):** el saludo de respaldo (`greeting_fallback`) ya no contesta a un cliente identificado
si el mensaje trae contenido (números o más de 3 palabras): pasa al agente. Una línea de una FAQ con
un `{{token}}` sin dato se saca entera (nunca "programado para: " vacío). La FAQ de stock toma el
código de la frase ("¿tienen stock del 506?") y responde con el stock real (`_shared/stock.ts`).

## Flujo 2: Consulta de pedido

> **28/09 (Pablo):** la respuesta de estado nombra cada pedido por su fecha (nunca el número), saca los
> anulados/borrados/no enviados y depende del modo de entrega: *expreso* → "el jueves 01/10 lo entregamos en el
> expreso X" + "los tiempos de viaje los maneja el expreso: consultalo con ellos" (a un cliente de expreso nunca se
> le ofrece retirar); *retira* → "lo podés retirar desde…"; *reparto* → "sale el…". Sin fecha → "todavía sin fecha
> de salida".
>
> **30/09 (Pablo):** sólo lista los pedidos que **faltan entregar** (de los últimos 30 días); los demás los da por
> entregados y cierra con "Si tu consulta es por otro pedido, confirmame de qué fecha es y lo reviso" (la fecha que
> contesta la busca el agente). El entregado al expreso sigue en la lista 7 días, porque al cliente puede no haberle
> llegado, y todo pedido por expreso lleva "la fecha en que te llega puede diferir según el expreso". Si están todos
> entregados, nombra el último con su fecha de entrega.
> "Hace 10 días hice un pedido, quería saber el estado" / "¿está confirmado mi pedido?" van a esta respuesta fija
> (`RE_ESTADO_PEDIDO`) y no a la IA, que convertía "hace 10 días" en una fecha equivocada. Con fecha explícita ("el
> pedido del 17/9") sigue la IA, que tiene prohibido convertir referencias relativas en fechas (`agente-fijos.ts`).
> "¿Qué plazo de entrega manejan?" (`RE_PLAZO_ENTREGA`) → la misma lista con la *entrega estimada* de la confirmación
> (`wa_fecha_estimada`) en los pedidos sin fecha; sin pedidos por entregar sigue el flujo normal. No se pregunta si le
> llegó la confirmación (con la llave en "prueba" no le llega a ningún cliente).
> "Figura el 30/09 pero en el detalle dice 13/10" (`RE_FECHAS_NO_COINCIDEN`) → "una persona revisa las fechas y te
> confirma" + alerta `entrega`. Regla fija de la IA: nunca asumir que el cliente se equivocó.

> **01/10 (Pablo Olejavetzky) — pedidos por marca (`_shared/pedidos-marca.ts`):** "cuando un cliente de Chef pregunta por la
> llegada de su pedido, podríamos ver los pedidos que tiene cargados; si tiene de ambos, preguntarle de qué marca es".
> - **Cliente sólo de Chef:** se le muestran sus pedidos de Chef (`chef_orders_cache` unido por CUIT o por su código de Chef) con el estado
>   de la vista `gv_pedido_web_estado_pagina` (empresa chef): programado → "sale el martes 06/10", armado/pickeado → "en preparación",
>   facturado, entregado (sólo si fue en los últimos 3 días). Un pedido que todavía no figura en Gestión y tiene hasta 7 días → "recibido,
>   todavía sin fecha de salida"; con más de 7 días se da por entregado. Si el pedido trae `reingreso_desde` en el futuro (artículos que
>   todavía no ingresaron) no se promete la fecha de la vista: "una persona del equipo te confirma la fecha de salida".
> - **Cliente de Loekemeyer que también compra en Chef (mismo CUIT):** sin pedidos de Chef en curso → la respuesta de siempre; con pedidos
>   en curso sólo en Chef → esos, titulados "de Chef"; **con pedidos en curso en las dos marcas** → *"tenés pedidos en curso de las dos
>   marcas. ¿De qué marca es el pedido que consultás: Loekemeyer o Chef? (o escribí los dos)"*. La respuesta ("Chef", "Loeke", "los
>   dos") se reconoce porque lo último del historial es esa pregunta (menos de 30 min). Si ya nombra la marca en la pregunta no se le pregunta.
> - Preguntas que cubre `esConsultaEstado`: `RE_ESTADO_PEDIDO`, `RE_PLAZO_ENTREGA` y "¿cuándo llega?", "¿dónde está mi pedido?", "¿ya salió?".
>   No cubre reclamos ("no me llegó": `RE_NO_LLEGO`) ni "cuándo ingresa el artículo" (`RE_INGRESO`). Con fecha explícita ("el del 17/9") un cliente de
>   LK sigue por la IA, como siempre.
> - **Límite conocido:** los pedidos que Chef carga directo en Gestión (order_id ≥ 1.000.000) no pasan por la web y no tienen cliente asociado:
>   el bot no los ve.

```
CLIENTE: ¿Sabés cuándo me entregan el pedido?
BOT: Garbarino Franco Tomas, estos son tus pedidos que faltan entregar:

     1️⃣ Pedido del 30/09 — 🚚 programado: lo podés retirar desde el lunes 05/10
     2️⃣ Pedido del 25/09 — 🧾 facturado, listo para salir: lo podés retirar desde el miércoles 30/09

     Los demás pedidos ya están entregados. Si tu consulta es por otro pedido, confirmame de qué fecha es y lo reviso.
CLIENTE: El del 14/09
BOT: (agente, con consultar_mis_pedidos) Tu pedido del 14/09 se entregó el viernes 18/09 …
```

### Revisión del Excel "Respuestas bot por causa" (Pablo, 30/09) — respuestas fijas nuevas (`faq.ts`, sin IA)

| Fila | Mensaje | Respuesta |
|---|---|---|
| 2.9 | "Anulá todo el pedido" | No es un cambio: dice en qué estado está el pedido (sin preparar / programado / facturado) y deriva con motivo `anulacion_pedido` (urgente). Con más de un pedido abierto y sin fecha, pregunta cuál. |
| 3.3 | "¿Cierran para almorzar?" | "El depósito cierra para almorzar de 12 a 13" + horario completo. |
| 3.4 | "Estoy llegando, ¿me esperan?" | "¡Te esperamos!" + dirección y horario. |
| 4.1 / 4.2 | "Llegaron 59 de 60, pido la NC" | Disculpas + pide el número de factura; el reclamo queda registrado ya. |
| 4.3 | "No veo el descuento en las facturas" | Sólo la última factura con sus descuentos por fecha, por qué no figura el descuento y "si querés, te paso el detalle" del resto. |
| 4.4 | "Me facturaron dos veces" | Busca en las facturas (isis_lk.documentos) dos del mismo importe en 15 días; las nombra si las hay. Deriva siempre. |
| 4.5 | "No me llegó la factura, ¿me la mandás?" | Reenvía la factura en PDF (`lookupFacturaReenvio`). |

IA (`agente-fijos.ts`): tono cordial sin muletillas (2.4); nunca asumir que el cliente se equivocó (1.9); código
inactivo = "discontinuado" + parecidos con link de foto (2.5, `buscar_productos`); anular con el estado y motivo
`anulacion_pedido`. El resumen del pedido por WhatsApp dice a nombre de qué razón social y CUIT va (2.12).

## Flujo 3: Nuevo pedido (30/09: precarga por WhatsApp, `sql/112`)

Se prende en Configuración del agente › 🛒 Pedidos por WhatsApp (`app_settings.wa_pedidos_config`; apagado por
defecto). Sólo números vinculados y aprobados. El agente: confirma artículos y cajas → pregunta SIEMPRE forma de pago
(`opciones_de_pedido`) → pregunta SIEMPRE entrega (si retira, día hábil desde +3 hábiles y franja) → `armar_pedido`
(misma cuenta y ficha que la web, **sin el 2% web**; stock; pedido parecido abierto en 7 días con ≥50% de artículos
iguales → pregunta si es otro o el mismo) → muestra el resumen → con el "sí" `confirmar_pedido`. Eso deja una
**precarga** (`wa_pedido_precarga`, Gestión no la ve) y una tarea "Pedido por WhatsApp" con **Confirmar y enviar a
Gestión** / **Descartar** (lk_alertas `pedido_confirmar`/`pedido_descartar`). Confirmar crea el pedido con su ficha
(origen "WhatsApp"): retry-sheets lo manda al Sheet y al cliente le llega "pedido recibido". Modo "directo" confirma
solo. Pedido en varios mensajes seguidos: durante un pedido (o si el mensaje trae cantidades/códigos, o llegó otro
hace < 6 s) el webhook espera 5 s y, si llegó otro, guarda éste en el historial sin contestar y contesta el último.
Al mostrar un artículo usa el precio del cliente (lista − dto por volumen). El ejemplo de abajo es el flujo viejo
(bot_submit_order, sin uso).
**Cotizador (sql/113):** un Excel cuyo nombre, hoja o contenido dice "cotizador" (o con caption "cotizador") se lee como
pedido por archivo ("Recibimos tu cotizador. Leímos esto: …"); con pedidos prendidos, el "sí" sigue el mismo circuito y
se precarga con origen **"Cotizador" y el 2% web** (como en la web). Cualquier otro archivo sigue con origen
"WhatsApp". Al precargar se cierra la tarea "Pedido por archivo" para que nadie lo cargue dos veces.

### (viejo)

```
CLIENTE: Quiero pedir
BOT: Dale, decime qué necesitás (producto y cantidad en cajas).
CLIENTE: 12 cajas de cuchillo asado y 6 de espatula
BOT: Agregué:
     • 12 cajas Cuchillo Asado 22cm (×12 u/caja) — $X
     • 6 cajas Espátula Nylon (×24 u/caja) — $Y
     ¿Algo más?
CLIENTE: 4 cucharones nylon
BOT: Agregué:
     • 4 cajas Cucharón Nylon (×24 u/caja) — $Z
     ¿Algo más?
CLIENTE: Listo
BOT: Resumen de tu pedido:
     • 12 cajas Cuchillo Asado 22cm — $X
     • 6 cajas Espátula Nylon — $Y
     • 4 cajas Cucharón Nylon — $Z
     Subtotal: $XX.XXX
     Dto web 2%: -$X.XXX
     Total: $XX.XXX
     ¿Confirmo? (Sí/No)
CLIENTE: Sí
BOT: ✅ Pedido NP-4530 confirmado. Te aviso cuando lo programemos.
```

## Flujo 4: Consulta retiro

```
CLIENTE: ¿Puedo pasar a retirar?
BOT: Tu pedido NP-4521 está programado para 28/08.
     Si querés retirarlo antes, contactá a ventas para coordinar.
     📞 (011) XXXX-XXXX
```

## Flujo 5: Notificación proactiva

```
BOT: 📦 Tu pedido NP-4521 fue programado para entrega el 28/08.
     [template: pedido_programado]

BOT: ✅ Tu pedido NP-4521 fue entregado.
     [template: pedido_entregado]
```

## Flujo 6: Reactivación

```
BOT: Hola {nombre}! Hace 95 días que no nos hacés un pedido.
     ¿Necesitás algo? Respondé y te ayudo.
     [template: reactivacion_cliente]
```

## Manejo de errores

```
CLIENTE: asdf
BOT: No entendí. Podés preguntarme por:
     📦 Estado de pedidos
     🛒 Hacer un pedido
     💬 O escribime tu consulta y te ayudo
```

## Opt-out

```
CLIENTE: No quiero recibir más mensajes
BOT: Listo, no te vamos a enviar más notificaciones.
     Si cambiás de opinión, escribinos cuando quieras.
```
