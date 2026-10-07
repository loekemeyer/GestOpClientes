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
BOT: Todavía no te tengo registrado como cliente. 🤔
     • Si ya sos cliente: pasame tu CUIT (con o sin guiones) y te vinculo este número.
     • Si querés ser cliente: escribí registrarme y te tomo los datos (te pregunto de a uno).
CLIENTE: 30-71234567-8
BOT: Encontré la cuenta de *Comercial Ejemplo S.R.L*. 👍
     Por seguridad, un asesor tiene que confirmar que este número es de la empresa
     antes de vincularlo. Te avisamos por acá apenas quede listo. 🙏
(admin aprueba en el dashboard)
BOT: Hola Comercial Ejemplo S.R.L, te escribimos de Loekemeyer.
     Ya vinculamos este número a tu cuenta: podés consultar tus pedidos, descuentos y fechas de entrega.
```

**Quiere ser cliente (05/10, `_shared/alta.ts`):** arranca la toma de datos (primer paso: el CUIT) cuando escribe *"me gustaría / quisiera / quiero ser cliente"*, *registrame*, *soy nuevo*,
*que me registren*, *abrir cuenta*… o cuando contesta **"sí" / "dale" / "sí, por favor"** a una oferta de registro del bot (el saludo *"Decime si querés que te registre"* o el *"Todavía no te tengo
registrado"*). Un "sí" suelto sin esa oferta anterior no arranca nada, y *"dale, ya te lo paso"* tampoco (no es una afirmación pura). Si el CUIT del primer paso ya es de un cliente, el alta se
corta y pasa a vinculación aprobada por una persona.

```
CLIENTE: Hola me gustaría ser cliente
BOT: ¡Genial! Te tomo los datos para registrarte. 📋 Te voy a ir preguntando de a uno. Si querés cortar, escribí *cancelar*.
     🔢 ¿Cuál es tu CUIT? (11 números, con o sin guiones)
```

**Constancia de inscripción (06/10, `_shared/constancia.ts`):** el alta ofrece que mande el PDF de ARCA. Si lo manda (y es un PDF con texto), el bot lo lee por reglas, sin IA, y le muestra lo que leyó;
con su *sí* se saltan CUIT, razón social e IVA, y en la dirección se le propone el domicilio fiscal. Si el CUIT ya es cliente (Loekemeyer o Chef) va a vinculación con revisión humana. Una constancia vencida (valen 30 días) no se usa: se le pide una nueva. Foto o escaneo: se guarda y
lo revisa una persona, y el bot repite la pregunta que quedó pendiente.

```
BOT: ¡Genial! Te tomo los datos para registrarte. 📋 … 📄 Si tenés la constancia de inscripción de ARCA en PDF, mandámela y me ahorrás varias preguntas.
CLIENTE: (manda constancia.pdf)
BOT: Leí tu constancia de inscripción. 📄
     • CUIT: 30-71234567-8
     • Razón social: EJEMPLO COMERCIAL S.A.
     • Condición frente al IVA: Responsable inscripto
     ¿Son correctos? Respondé sí y sigo con el resto de los datos, o no y los cargamos a mano.
CLIENTE: sí
BOT: Perfecto, ya tengo tus datos fiscales. ✅ 👤 ¿Nombre de contacto? (nombre y apellido)
```
(…más adelante, en la dirección: *"¿Entregamos en tu domicilio fiscal, Av Ejemplo 1234, Rosario, Santa Fe (CP 2000)? Respondé sí, o pasame la dirección de entrega"*.)

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
| ya pagué, te paso el comprobante | "Le paso a Cobranzas" + los datos de Cobranzas de Chef (ficha Empresas, 01/10) | `pago` |
| mandame la factura (fase 3) | el PDF de `isis_ch.documentos` (bucket isis-ch) del último día facturado o de la fecha/mes que nombre, con el saldo y el descuento de la factura y los datos de pago de Chef | `pago` si Chef no tiene alias cargado |
| me facturaron dos veces (fase 3) | busca dos facturas de Chef del mismo importe en 15 días | `reclamo` siempre |
| ¿qué descuento tengo? (fase 3) | cada factura de Chef abierta con su descuento (`dto_cond` hasta `vence`) | — |
| ¿cuándo llega mi pedido? (01/10) | sus pedidos de Chef de los últimos 30 días con estado y fecha de salida (`pedidos-marca.ts`, vista `gv_pedido_web_estado_pagina` empresa chef); sin pedidos → "no veo pedidos de Chef en los últimos 30 días"; Gestión no responde → "le paso a una persona" | `entrega` si Gestión no respondió |
| ¿tienen X? / hay stock del 437E / precio del colador (fase 4, paso A, 01/10) | hasta 8 productos del catálogo de **Chef** (`chef_ext.products`, RPC `bot_buscar_productos_chef`, sql/121) con código, descripción de Chef, unidades por caja y, si son 5 o menos, stock de Chef ("hay" / "limitado" / "sin"). **Sin precio ni foto**: si pide precio, "te lo pasa una persona". Sin resultado → "no encontré ese producto, le paso a una persona" | `cliente_chef` si pide precio, no lo encuentra o pide el catálogo; `consulta_stock` si es un solo artículo y no hay stock |
| mandame la foto del 437E (fase 4, paso C, 01/10) | **una** foto del producto de Chef (JPEG por código en el bucket público `products-images` de la base de Chef, verificada con un HEAD antes de prometerla). Con varios resultados lista los productos y pide el código; sin producto pregunta "¿de qué producto querés ver la foto?"; si la foto no está o el almacenamiento no responde, "le aviso a una persona del equipo para que te la mande". Textos en tono cálido (01/10: "¡Claro! Acá te paso la foto de *X* (cód. …). 📷" y el pie "X (cód. …). Viene en caja de N. 😊") "Foto de la rotura / del comprobante" no cuenta: sigue a una persona. El Simulador (v0.26.9) dibuja la foto debajo de la respuesta | `cliente_chef` si no se pudo conseguir la foto o si pidió también el precio |
| cualquier otra cosa | "Te responde una persona del equipo" | `cliente_chef` (una cada 2 h; va a Planify) |

Un cliente de LK que además le compra a Chef (mismo CUIT) recibe lo mismo en las respuestas de pagos de LK: pago recibido, reenvío, factura duplicada y descuentos (#8) miran también Chef, y cada factura sale con los datos de pago de SU empresa.

Cliente molesto y adjuntos siguen el camino de siempre; la alerta lleva `empresa: CH`, el código de Chef y el CUIT.

**Vinculación:** si el CUIT no es de LK pero sí de Chef, queda una solicitud de Chef pendiente (antes arrancaba el
alta). Al aprobarla se carga en `bot_chef_whatsapps`, nunca en `bot_customer_whatsapps` (D008). En Vinculaciones y
en Tareas se ve "Chef" al lado del código.

## Flujo 1d: Cliente de las dos marcas — puerta de marca (01/10, `_shared/marca.ts`)

Pedido de Pablo Olejavetzky: *"cuando se le hace una consulta algún cliente que tenga ambas marcas, deberíamos consultarle a cuál se
refiere, también con los pedidos; es el doble de trabajo de flow, pero es la única que va a quedar bien y sin errores"*.

Es de "las dos marcas" un cliente de Loekemeyer cuyo CUIT también es cliente de Chef (`bot_cuentas`, empresa CH) **y le compró a Chef
hace poco**: una factura de Chef en los últimos 12 meses (`isis_ch.documentos`) o un pedido en los últimos 90 días (`chef_orders_cache`).
Medido el 01/10: de 357 clientes que están en las dos empresas, 64 (17,9 %) tienen factura de Chef en 12 meses; a los otros 293 (82,1 %)
no se les pregunta. Si Gestión no responde, se pregunta (ante la duda, se pregunta). Antes del FAQ y del agente (después de las
respuestas a avisos y de pedido en curso):

| el mensaje es | el bot |
|---|---|
| saludo, "gracias", o una consulta de plata (facturas, saldo, pagos, comprobante, descuentos, datos para transferir) | no pregunta: esas respuestas ya separan las dos empresas |
| nombra la marca ("el pedido de Chef", "la factura de Loeke") | la usa, sin preguntar |
| de hace menos de 15 min hay una respuesta con etiqueta *Chef* / *Loekemeyer* | sigue con esa marca |
| cualquier otra cosa | *"¿De qué marca es tu consulta: Loekemeyer o Chef?"* (en consultas de pedido suma "o escribí los dos") |

Con la respuesta se contesta la consulta original (el último mensaje suyo que no es una respuesta de marca):
- **Chef** → `atenderClienteChef` (lo que Chef ya contesta: pedidos, facturas, pagos; lo demás, una persona con la alerta marcada Chef).
- **Loekemeyer** → el flujo de siempre (FAQ y agente).
- **Los dos** → solo para pedidos (las dos listas, cada una con su marca); para otro tema pide ir de a una marca.

**La etiqueta es la memoria:** cada respuesta de marca arranca con `*Chef*` o `*Loekemeyer*` y la marca elegida se lee del historial
(`bot_historial_chat`), sin tablas nuevas. A los 15 minutos se vuelve a preguntar: ante la duda, se pregunta. Cuando Chef sume una
herramienta, entra en `atenderClienteChef` y la puerta no cambia.

Fuera de la puerta: un cliente de una sola marca no recibe la pregunta, y si `puertaMarca` falla el webhook sigue por el flujo de siempre.

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

**Comprobante de pago y consultas de pago → datos de Cobranzas (01/10, Pablo):** el cliente recibe cómo comunicarse con Cobranzas,
del dato `cobranzas` de la ficha Empresas (WhatsApp o mail; Chef vacío no cae al de Loekemeyer: si falta, el mensaje sale como antes).

| El cliente | Responde | Dónde |
|---|---|---|
| manda una imagen o PDF que habla de pago ("comprobante", "transferí") | texto de la plantilla `comprobante_recibido` (Loekemeyer) o `comprobante_recibido_chef` (cliente sólo de Chef) con el dato de Cobranzas; alerta `comprobante_recibido` | `handleAdjunto` (webhook) + `respuestaComprobante` (`empresas.ts`) |
| "¿recibieron el pago?" y no figura en los últimos 7 días | el mensaje de siempre + "Para consultas sobre tus pagos podés comunicarte con Cobranzas: …" (las empresas en las que tiene cuenta) | `pagoRegistrado` (`faq.ts`) |
| "ya pagué" (cliente de Chef) | "Le paso a Cobranzas…" + el dato de Cobranzas de Chef | `chef.ts` |
| pide pagar en otra fecha ("¿se podrá efectuar el pago el próximo viernes?", "¿les puedo pagar la semana que viene?"; 06/10, m64) | "Le paso tu consulta a Cobranzas para que te confirme por acá si se puede pagar en esa fecha"; no promete nada. Antes salían los medios de pago (#15) sin contestar lo que preguntó. Detector `pidePagarDespues` (`faq.ts`): verbo de pagar + fecha futura. Si el cliente contesta un recordatorio de descuento, sigue mandando `responderRecordatorio` ("Posterga", arriba); "ya pagué", "el viernes pasado" y "¿recibieron el pago?" siguen su camino | `pago` (`pidePagarDespues`, `faq.ts`) |
| algo de pagos que va a una persona (IA, motivo `pago`) | la IA le pasa `datos_cobranzas` tal cual | `derivar_a_persona` (`bot-conversation.ts`) |

Las plantillas están definidas en `plantillas-meta.ts` y **todavía no están subidas a Meta**: dentro de las 24 h el texto sale como
mensaje libre; la plantilla es para mandarlo fuera de la ventana. Si el cliente tiene cuenta en las dos empresas, el comprobante
recibe los datos de Loekemeyer (no se sabe a cuál va el pago).

**Audios (01/10, Pablo):** con `app_settings.wa_audio_activo` = 1 el bot transcribe la nota de voz (Groq Whisper, `_shared/transcribir.ts`) y
procesa el texto como un mensaje escrito (FAQ, agente, "ya pagué", pedidos). Apagado de fábrica.

| El cliente manda | Pasa |
|---|---|
| un audio, llave prendida, número autorizado | se transcribe, el bot muestra "🎤 Entendí: «…»" (`wa_audio_eco`) y contesta como si lo hubiera escrito |
| un audio, llave apagada | "Por ahora no podemos escuchar audios…" + alerta `adjunto_recibido` (como antes) |
| un audio que no se pudo entender (muy largo, silencio, `.amr`, límite o caída de Groq) | "No pudimos entender tu audio. Escribinos…" + alerta `adjunto_recibido` |
| un audio desde un número fuera de la whitelist o en la blacklist | no se transcribe (no sale a Groq): sigue el camino de siempre |
| un video o un sticker | "no podemos ver videos…" + alerta, como antes |

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
**Retiro (01/10, Pablo):** (1) la fecha del PROPIO pedido ("el pedido del 30/09 me lo entregan o lo paso a buscar?") ya no se
toma como día de retiro: antes iba a un asesor "para reprogramar" y ahora sigue a las FAQ / el agente, que contestan con el
estado real. (2) Si pide retirar un día anterior al que el pedido está listo ("¿puedo pasar a retirar mañana?"), se le dice
la fecha real ("está programado: lo podés retirar desde el lunes 05/10…") y se le ofrece pasarlo a un asesor si necesita otro
día; si insiste, recién ahí deriva. Si pide un día igual o posterior, se le confirma directo (como desde el 29/09).
**Retiro: franja y aviso a Ventas (07/10, Pablo, m36 y m37):** al confirmar el día ("Sí, podés retirar tu pedido del 30/09 el jueves 08/10, de 9 a 12 o de 13 a 16:30 h, en Virgilio 2788. ✅")
suma *"¿Pasás por la mañana o por la tarde? Le avisamos a Ventas para que lo tenga a mano."* y deja una alerta `entrega` (no urgente, → Ventas) con "Va a retirar el pedido del 30/09 el jueves 08/10 (franja sin confirmar)".
Si el cliente contesta la franja ("a la mañana", "por la tarde", "mañana a la tarde" = la tarde; un mensaje corto, sin "puedo…" ni un cambio de fecha), el bot dice *"Perfecto, te esperamos el jueves 08/10 por la mañana. Ya le avisamos a Ventas."*
y sale un segundo aviso `entrega` que completa el primero. Hoy pasado el mediodía no se pregunta la franja (sólo queda la tarde). Reconoce la respuesta porque el mensaje anterior del bot trae la pregunta (`PREGUNTA_FRANJA`). Código en `_shared/fecha-retiro.ts` y `pedidoDeCambio`.

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
**Sólo si la pide (05/10, Pablo):** por palabra clave la #10 se disparaba con cualquier mensaje que dijera "factura" y "¿Eso son las 3
facturas?", dicho justo después de recibirlas, las volvía a mandar. Ahora reenvía si el mensaje es un pedido (`RE_PIDE_FACTURA`: "mandame / pasame
la factura", "no me llegó la factura"; `RE_QUIERE_FACTURA`: "necesito / quiero / no recibí / no encuentro la factura", "¿dónde está la factura?",
"la factura?" sola). Cualquier otra pregunta sobre facturas ("¿son estas cuatro?", "¿tiene el descuento?") devuelve `null` y la contesta la IA, que ve la
charla y consulta sus facturas (`consultar_mis_facturas`): gasta IA. Pruebas sin red: `deno run --allow-env tests/faq-reenvio.test.ts`.

**FAQ (28/09):** el saludo de respaldo (`greeting_fallback`) ya no contesta a un cliente identificado
si el mensaje trae contenido (números o más de 3 palabras): pasa al agente. Una línea de una FAQ con
un `{{token}}` sin dato se saca entera (nunca "programado para: " vacío). La FAQ de stock toma el
código de la frase ("¿tienen stock del 506?") y responde con el stock real (`_shared/stock.ts`).

## Flujo 2: Consulta de pedido

> **28/09 (Pablo):** la respuesta de estado nombra cada pedido por su fecha (nunca el número), saca los
> anulados/borrados/no enviados y depende del modo de entrega: *expreso* → "el jueves 01/10 lo entregamos en el
> expreso X" + "los tiempos de viaje los maneja el expreso: consultalo con ellos" (a un cliente de expreso nunca se
> le ofrece retirar); *retira* → "programado para el lunes 05/10", y ya facturado "facturado, listo para retirar desde el martes 06/10" (07/10, m21: un pedido de retiro dice "listo para retirar"; el título pasa a "que falta retirar", y "pendientes" si hay retiro mezclado con reparto); *reparto* → "sale el…". Sin fecha → "todavía sin fecha
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
> "¿Qué plazo de entrega manejan?" (`RE_PLAZO_ENTREGA`) → desde el 06/10 (m61) primero el plazo general, **"14 días hábiles desde que hacés el pedido"**
> (fijo, `_shared/plazo-entrega.ts`), y debajo la lista con la *entrega estimada* de la confirmación
> (`wa_fecha_estimada`) en los pedidos sin fecha; sin pedidos por entregar, sólo el plazo general. No se pregunta si le
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
> - **Cliente de Loekemeyer que también compra en Chef (mismo CUIT):** siempre se le pregunta de qué marca es la consulta (puerta de
>   marca, Flujo 1d), tenga o no pedidos en curso en cada una: un atajo "si solo uno tiene pedidos, no pregunto" contestaba mal
>   cuando el cliente se refería a un pedido ya entregado de la otra marca. Con "Chef" ve la lista de Chef; con "Loekemeyer", la de
>   siempre; con "los dos", las dos listas con su marca.
> - Preguntas que cubre `esConsultaEstado`: `RE_ESTADO_PEDIDO`, `RE_PLAZO_ENTREGA` y "¿cuándo llega?", "¿dónde está mi pedido?", "¿ya salió?".
>   No cubre reclamos ("no me llegó": `RE_NO_LLEGO`) ni "cuándo ingresa el artículo" (`RE_INGRESO`). Con fecha explícita ("el del 17/9") un cliente de
>   LK sigue por la IA, como siempre.
> - **Límite conocido:** los pedidos que Chef carga directo en Gestión (order_id ≥ 1.000.000) no pasan por la web y no tienen cliente asociado:
>   el bot no los ve.

```
CLIENTE: ¿Sabés cuándo me entregan el pedido?
BOT: Garbarino Franco Tomas, estos son tus pedidos pendientes:

     1️⃣ Pedido del 30/09 — 🚚 programado para el lunes 05/10
     2️⃣ Pedido del 25/09 — 🧾 facturado, listo para retirar desde el miércoles 30/09

     Los demás pedidos ya están entregados. Si tu consulta es por otro pedido, confirmame de qué fecha es y lo reviso.
CLIENTE: El del 14/09
BOT: (agente, con consultar_mis_pedidos) Tu pedido del 14/09 se entregó el viernes 18/09 …
```

### Revisión del Excel "Respuestas bot por causa" (Pablo, 30/09) — respuestas fijas nuevas (`faq.ts`, sin IA)

| Fila | Mensaje | Respuesta |
|---|---|---|
| 1.8 | "Quería consultar qué período de tiempo están contemplando para entregas" | "El plazo de entrega hoy es de 14 días hábiles desde que hacés el pedido" + sus pedidos por entregar con la entrega estimada, si tiene (`textoPlazo`, `plazo-entrega.ts`; 06/10, Pablo: "14 días hábiles fijo", no el cálculo por modo de `wa_fecha_estimada`). Antes mostraba sólo los pedidos y no decía el plazo. |
| 5.4 | "Te consulto, ¿me dirías el precio de lista? Me refiero al automate" | Si nombró un artículo y no se lo halló por código, ya no pregunta "¿De qué artículo? Pasame el código o el nombre": lo toma la IA (`buscar_productos`), que sabe decir que está discontinuado (`hayNombreDeArticulo`, `articulo-nombre.ts`; 06/10, m72). Sólo se sigue preguntando si no nombró nada ("¿cuánto sale?"). Vale también para el stock. La herramienta `buscar_productos` ahora también reconoce un discontinuado por NOMBRE (antes sólo por código): "automate" → "Automate (cód. 597) está discontinuado" + parecidos activos, y no la "Bombilla Autolimpiante" que sugería la búsqueda por trigramas. **Causa:** la búsqueda por nombre de la respuesta fija (RPC `wa_product_match`) falla en cada llamada por un error de tipos y además sólo mira artículos activos. |
| 1.5 | "Por favor recuerden que recibimos hasta las 14 hs, por lo que deben llegar un ratito antes" | "Anotado, gracias por avisarnos. Le voy a comentar al equipo para que lo tengan en cuenta." + alerta `nota_cliente` (🟢, 240 min) para Ventas con el texto del cliente (`avisaHorarioRecepcion`, `faq.ts`; 06/10, m60). Antes la IA decía lo mismo pero no dejaba nada: el horario no le llegaba a nadie. Hace falta un verbo de recepción + un horario ("hasta las 14", "de 8 a 14"). Guardarlo como observación en un campo de la ficha del cliente queda pendiente (Pablo eligió, por ahora, sólo la alerta). |
| 1.7 | "En el caso que se confirme, ¿hay posibilidades de entrega rápida?" | "Una persona de Ventas revisa si se puede acelerar la entrega y te escribe por acá en un momento" + alerta `entrega` (🟡, 120 min) para Ventas (`pideEntregaRapida`, `faq.ts`; 06/10: "todas las dudas pasan por Ventas primero"). Hace falta una palabra de entrega junto a una de apuro ("entrega rápida/urgente", "adelantar la entrega", "que llegue antes"); "¿cuándo llega mi pedido?", "¿puede estar para el viernes?" y "no me llegó" siguen su camino. Antes salía la lista de pedidos pendientes (#1) sin contestar si se podía acelerar. |
| 2.2 | "Paso un pedidito. ¿Puede estar para el viernes?" | "Hoy la entrega estimada es de 14 días hábiles: si hacés el pedido hoy, sería el martes 27/10. Para la fecha que necesitás lo consulta una persona de Ventas y te escribe por acá. ¿Qué artículos necesitás?" + alerta `entrega` (🟡, 120 min) para Ventas. La fecha cuenta lunes a viernes sin feriados ni puentes del calendario de Planify. Hace falta pasar/hacer un pedido NUEVO y "¿puede estar para el X?" (`pedidoParaFecha`, `faq.ts`; 06/10, m62); "¿puede llegar el viernes mi pedido?" de un pedido ya hecho sigue en la lista. Antes la IA contestaba "no puedo prometerte una fecha" sin dar ninguna. |
| 4.8 | "Nos llegó al mail las facturas, ¿lo entregan hoy?" | (07/10, m68) La lista de pedidos de siempre y, debajo, *"¿A qué mail te llegaron las facturas? Lo chequeo."* (`avisaFacturaPorMail`, `_shared/mail-facturas.ts`; hace falta decir que la factura llegó por mail + una palabra de entrega o de pedido; "no me llegó la factura" sigue en el reenvío). Cuando el cliente contesta con un mail, `pedidoDeCambio` lo compara con `customers.mail` (minúsculas, separando por coma, punto y coma y espacio; coincide sólo si TODOS los que dice están en la ficha): coincide → *"Perfecto, es el mismo que tenemos registrado."* sin alerta; no coincide → *"Ese mail no coincide con el que tenemos registrado. Una persona de Ventas lo revisa y te escribe por acá."* + alerta `nota_cliente` (verde, Ventas); la ficha sin mail (95 de 1.263 clientes) → *"Gracias, se lo paso a Ventas para que lo chequee."* + la misma alerta. Nunca se le muestra el mail registrado. |
| 2.12 | "Cargué todo por unidad y después lo edité por caja" | "Gracias por avisarnos. Una persona de Ventas revisa cómo quedó cargado tu pedido y te escribe por acá. 🙏" + alerta `cambio_pedido` (🔴 por defecto) para Ventas con el mensaje (`avisaErrorDeCarga`, `faq.ts`; 06/10, m17). Antes la IA repreguntaba "¿está hablando de un pedido que ya hizo en la web, o de algo que quiere hacer ahora?". Hace falta unidad Y caja con un verbo de carga/edición, o una equivocación con pedido/carga/cantidad: "ya cargué el pedido" o "puse 10 cajas" solos no cuentan. |
| 2.5 | "6 cajas de pelapapas 505, 1 caja abrelatas 501, lo retiro yo" | La IA (regla `REGLA_PEDIDOS_WA`, paso 1, `agente-fijos.ts`; 06/10, m12) confirma código, descripción y cajas y, **en el mismo mensaje**, chequea el stock de cada artículo (`consultar_stock`) y da el **precio por caja del cliente, con su descuento por volumen** (`precio_cliente_por_caja` de `buscar_productos`; si no viene, el de lista). El total NO lo calcula el modelo: lo da `armar_pedido` en el resumen. Después sigue pidiendo forma de pago y entrega. Antes sólo listaba los artículos. **(07/10, m12, segunda vuelta)** Las formas de pago se muestran numeradas 1 a 6 (`opcion`), sin los códigos internos 8, 9, 10… (que quedan aparte, en `condicion_code`, sólo para `armar_pedido`) y sin "Prefiero no decidir ahora" (se sigue aceptando si el cliente lo pide). Si el cliente ya dijo que retira, en el MISMO mensaje pregunta forma de pago y día y franja del retiro (desde la fecha mínima de `opciones_de_pedido`, de lunes a viernes de 9:00 a 12:00 o de 13:00 a 16:30). Módulo puro `_shared/formas-pago.ts`; el modelo de respuesta que aprobó Pablo vive en `REGLA_PEDIDOS_WA`. |
| 2.6 | "Pasé por mail un pedido para un cliente pero me vino dos veces rechazado. ¿Te llegó a vos?" | Chequea duplicados en la web como siempre; si no hay y el mensaje nombra mail o correo (`pedidoPorMailRepetido`, `faq.ts`): "Revisé tus pedidos de los últimos 7 días y no veo ninguno repetido. Una persona revisa el mail y te escribe por acá" + alerta `pedido_mail` (🟡, 120 min) para Ventas. Sin mail, el mensaje de siempre ("si ves uno de más en la web…"). |
| 2.9 | "Anulá todo el pedido" | No es un cambio: dice en qué estado está el pedido (sin preparar / programado / facturado) y deriva con motivo `anulacion_pedido` (urgente). Con más de un pedido abierto y sin fecha, pregunta cuál. |
| 3.3 | "¿Cierran para almorzar?" | "El depósito cierra para almorzar de 12 a 13" + horario completo. |
| 3.4 | "Estoy llegando, ¿me esperan?" | (07/10, m39) *"Le aviso ahora mismo a Ventas para confirmar que te puedan esperar y te escribimos por acá en un momento. 🙏"* + dirección y horario, y una alerta `entrega` para Ventas: **urgente** con el depósito abierto (lunes a viernes, 9 a 12 y 13 a 16:30, sin feriados), no urgente con el depósito cerrado. Antes decía "¡Te esperamos!" sin avisar a nadie. |
| 4.1 / 4.2 | "Llegaron 59 de 60, pido la NC" | Disculpas + pide el número de factura; el reclamo queda registrado ya. |
| 4.3 | "No veo el descuento en las facturas" | Sólo la última factura con sus descuentos por fecha, por qué no figura el descuento y "si querés, te paso el detalle" del resto. |
| 4.4 | "Me facturaron dos veces" | Busca en las facturas (isis_lk.documentos) dos del mismo importe en 15 días; las nombra si las hay. Deriva siempre. |
| 4.5 | "No me llegó la factura, ¿me la mandás?" | Reenvía la factura en PDF (`lookupFacturaReenvio`). |
| 4.7 | "Vamos a devolver unas cucharas que no pedimos, es el código 208 y son 48 unidades" | Respuesta fija (`quiereDevolver`, `_shared/faq.ts`): "Una persona de Ventas revisa tu devolución y te escribe por acá para coordinarla" + alerta `devolucion` (🟡, 2 h) con el mensaje del cliente. Antes salía la respuesta del pedido mínimo (#21). Va a Ventas (sector 8 de Planify) cuando se cargue en Derivaciones; se cambia ahí sin tocar código. |

### Pedido mínimo y envíos (Pablo, 01/10, `sql/120`, `_shared/minimo.ts`)

- **"¿Cuál es el mínimo?" (#21) y "¿hacen envíos?" (#31)** son `semi_auto` (`db_lookup_type` `minimo_compra`): el bot
  completa `{{minimo_envio}}` / `{{minimo_retiro}}` con el **mínimo del cliente**: su excepción
  (`wa_minimo_excepciones`) o, si no tiene, el general (`app_settings.wa_minimo_compra`, $500.000 / $300.000). Un
  no-cliente recibe el general. 0 = "sin mínimo". Se cargan en Configuración del agente › 🛒 Pedidos por WhatsApp ›
  💰 Pedido mínimo.
- **La #31 ya no promete plazo** (decía "7-15 días hábiles"): sólo a dónde se entrega. "¿Cuánto tarda?" lo contesta
  `lookupOrderStatus` con plazo (`RE_PLAZO_ENTREGA`).
- **"¿Me hacen una excepción?" / "¿puedo pedir menos del mínimo?"** (`RE_EXCEPCION_MINIMO`) no se contesta con el
  mínimo: va a la IA, que no la promete ni la niega y deriva con motivo **`excepcion_minimo`** (lo decide un
  vendedor; destino en Configuración › Derivaciones).
- Es **informativo**: no frena pedidos. El aviso en pedidos por WhatsApp sigue siendo `wa_pedidos_config.minimo_*`
  (vacío desde el 30/09).

```
CLIENTE: Cuál es el pedido mínimo?
BOT: 💰 *Pedido mínimo*
     • Con envío (CABA, GBA o expreso): $500.000
     • Si lo retirás en el depósito: $300.000

     Si tu pedido no llega al mínimo de envío, lo podemos preparar para que lo retires: confirmanos si querés.
     Los retiros son en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30.
CLIENTE: ¿Me pueden hacer una excepción?
BOT: (agente, derivar_a_persona motivo excepcion_minimo) Lo consulto con tu vendedor y te escribe por acá.
```

IA (`agente-fijos.ts`): tono cordial sin muletillas (2.4); nunca asumir que el cliente se equivocó (1.9); código
inactivo = "discontinuado" + parecidos con link de foto (2.5, `buscar_productos`); anular con el estado y motivo
`anulacion_pedido`. El resumen del pedido por WhatsApp dice a nombre de qué razón social y CUIT va (2.12).
**Sin cierre de cortesía (Pablo, 05/10):** la IA contesta y termina; no cierra con "¿Necesitás algo más?" ni "cualquier consulta
avisame" (si tiene otra consulta la hace; si no, la charla termina). Dos capas: la regla CIERRE de `agente-fijos.ts` y el filtro
`_shared/cierre.ts` (`sinCierreGenerico`) sobre el texto final, que saca sólo la última oración cuando es un cierre genérico puro y
no toca las preguntas que piden un dato o una confirmación ("¿Agregamos 2 cajas?"). No aplica a los saludos de apertura ni a las
plantillas de Meta (`pedido_entregado` dice "si falta algo, avisanos por acá": cambiarlo exige otra aprobación de Meta).
**Ejemplos aprobados (Pablo, 06/10):** las correcciones que el dueño aprueba (`wa_agente_evals`, estado `aplicada`: respuesta modelo y/o regla) llegan al agente como guía cuando entra
una consulta parecida (`_shared/ejemplos-aprobados.ts`). Sólo el agente IA: la capa fija se cambia en código o en `wa_faq`. Procedimiento en `CLAUDE.md`.

## Flujo 3: Nuevo pedido (30/09: precarga por WhatsApp, `sql/112`)

**La web es la prioridad, el pedido por WhatsApp se toma igual (Pablo, 07/10, m18 y m19).** *"Siempre que se pueda canalizar los pedidos por la web, eso hace que todo el trabajo de la empresa sea más ordenado. Si lo manda por este medio, lo tomamos, pero la prioridad es la web."* Es una regla del prompt de la IA (`REGLA_PEDIDOS_WA`, primera línea, `agente-fijos.ts`; prueba en `tests/regla-pedidos.test.ts`): cuando el cliente pregunta cómo pedir, o quiere hacer un pedido y no pidió expresamente hacerlo por acá, lo invita primero a la web (loekemeyer.com › Pedidos Mayorista, con su CUIT y su clave: es más ordenado y hay un descuento extra, sin decir cuánto) y le dice que si prefiere pasarlo por acá también lo toma. Nunca dice que "no hace falta" entrar a la web. Si ya empezó a pasar los artículos, sigue con los pasos sin insistirle. Textos de guía aprobados: m19 *"Lo mejor es que lo hagas en la web: entrá a loekemeyer.com › Pedidos Mayorista con tu CUIT y tu clave. Es más ordenado y, por hacerlo por la web, tenés un descuento extra. Si preferís pasármelo por acá, también lo tomamos: decime qué artículos y cuántas cajas necesitás."* y m18 *"La prioridad es la web (loekemeyer.com › Pedidos Mayorista, con tu CUIT y tu clave): es más ordenado y tenés un descuento extra. Si lo mandás por acá, lo tomamos igual: decime qué artículos y cuántas cajas necesitás."* La IA los parafrasea. El "¿tenés un correo?" de m18 queda sin respuesta definida.

**Modelo FIJO para pedidos (Pablo, 05/10: "no podemos fallar ahí").** Los cotizadores / archivos y la toma de pedido NO pasan por la
cadena de modelos del Panel (hoy Gemini gratis #1): los contesta siempre **Claude Sonnet 4.6**. (1) Lector de archivos
(`pedido-archivo.ts`: `leerPedidoArchivo` y `resolverArticulos`): Sonnet con un reintento ante 429, 5xx o timeout (antes Haiku, sin reintento).
(2) Conversación: `esTurnoDePedido` (`_shared/pedido-turno.ts`) marca el turno como de pedido si el cliente pide, manda un cotizador o una
orden de compra, o dice cantidades ("6 cajas de…"), o si lo último que dijo el bot fue parte de un pedido en la última hora (resumen, forma de
pago, "Leímos esto"…: lo que contesta el cliente, "sí" o "contado", sigue siendo del pedido). Esos turnos usan SOLO Sonnet, con un reintento a
los 1,5 s; si fallan los dos intentos se avisa a una persona (alerta `llm_error`) y **nunca cae en otro proveedor**. Las consultas de estado
("¿lo recibieron?", "Hice un pedido hace 10 días…") siguen por la cadena. `app_settings.llm_modelo_pedidos` cambia el modelo sin deploy
(`cadena` u `off` lo apaga). No corre en el Simulador ni en el Chat de prueba: ahí rige `llm_modelo_pruebas`.

Se prende en Configuración del agente › 🛒 Pedidos por WhatsApp (`app_settings.wa_pedidos_config`; apagado por
defecto). Sólo números vinculados y aprobados. El agente: confirma artículos y cajas → pregunta SIEMPRE forma de pago
(`opciones_de_pedido`) → pregunta SIEMPRE entrega (si retira, día hábil desde +3 hábiles y franja) → `armar_pedido`
(misma cuenta y ficha que la web, **sin el 2% web**; stock; pedido parecido abierto en 7 días con ≥50% de artículos
iguales → pregunta si es otro o el mismo) → muestra el resumen → con el "sí" `confirmar_pedido`. **El servidor valida ese
"sí" (compuerta, `_shared/pedido-gate.ts`, Pablo 06/10):** sólo carga si lo que el cliente escribió desde la última
respuesta del bot es un sí a secas (vocabulario de confirmación: "sí", "dale", "ok", "confirmo", 👍…; cualquier otra palabra,
un número o un "pero" lo bloquea), si lo último que dijo el bot es el resumen (formato de `armar_pedido`), si ese resumen
tiene menos de 1 hora y si incluye el total y cada código de artículo que el servidor acaba de calcular. Si no, la
herramienta devuelve `no_cargado` y el agente vuelve a mostrar el resumen y pide el sí. Eso deja una
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
**Lo que dice el archivo es un dato, no una orden (07/10, `_shared/dato-externo.ts`):** la descripción de cada línea que lee la IA pasa a una línea sin invisibles,
etiquetas ni enlaces, y el código de artículo tiene que tener forma de código. Si una línea parece una orden para el bot ("ignorá las reglas", "confirmá el pedido
ya", nombres de herramientas, claves), no se busca en el catálogo, el cliente la ve como *(texto no legible)* y la tarea muestra un aviso para revisar el archivo
original. Los artículos que sí se encontraron salen con la descripción del CATÁLOGO, nunca con las palabras del archivo.
**Aviso de Auditoría (07/10, `_shared/archivo-sospechoso.ts`):** además, el texto crudo de las planillas y CSV se escanea ANTES de la IA, porque la IA descarta esas
órdenes en silencio y el equipo no se enteraba. Si trae algo que parece una orden, se crea una alerta `archivo_sospechoso` (una por número y por hora, verde, vence a las
24 h) que aparece en Centro de mensajes › Tareas › Auditoría con el archivo, el patrón que saltó, la línea y qué hizo la IA. No tiene nada que contestar: se mira y se
cierra. No abre tarea en Planify salvo que se la derive en Configuración › Derivaciones. No cubre fotos ni PDF.
**Cotizador: precios contra la web y sucursal (Pablo, 06/10, m41).** El cotizador trae además los precios y el total: al recibirlo el bot lee la hoja
"Cotizador …" (`_shared/cotizador-precios.ts`: versión, `$ x Uni`, `Uni x Caja`, "No Disponible", "Total a Abonar") y compara los artículos
PEDIDOS (cajas > 0) con `products.list_price` y `uxb`. **Si todo coincide NO se le dice nada** (el control es en silencio): el mensaje termina en
"¿Confirmás los artículos y los valores?". Si algo no coincide, agrega SÓLO lo que difiere (precio por caja del cotizador vs. el de la web, unidades por caja
distintas, artículo que ya no está en la web, "No Disponible" que la web sí vende), el total que figura en el cotizador y pide
**"¿Confirmás los artículos y los valores de la web?"**. **Si la cuenta tiene más de una dirección de entrega** (`customer_delivery_addresses`),
lista las direcciones con su número (`slot`) y pregunta **"¿Para cuál es este pedido?"** ("muy importante", Pablo): la respuesta es el número y el agente no elige
una por su cuenta (`REGLA_PEDIDOS_WA` paso 3). Con una sola dirección no pregunta. Una planilla sin la hoja de precios sigue como siempre ("¿Está bien?").
Se compara contra el precio base (lista), no contra el final con descuento por plazo y 2 % web. ⚠ Una cadena con lista propia de precios dispararía una falsa alarma: a vigilar.
**Cliente que PIDE el cotizador (Pablo, 06/10, m41):** respuesta fija (`faq.ts` `pideElCotizador`, antes del agente): "Ahora los pedidos se toman por la web: entrá a loekemeyer.com › Pedidos Mayorista con tu usuario (tu CUIT) y tu clave. Ahí ves los precios al día y armás el pedido. Si no tenés clave, escribinos y una persona de Ventas te la genera." No genera alerta; "no tengo clave" lo toma el reseteo de clave de siempre. Quien MANDA el cotizador va por el lector de archivos (arriba).

**Cliente que pregunta si puede pedir por la web (Pablo, 07/10, m77):** "¿Puedo hacer el pedido directo de la web? ¿Mismos precios, mismo todo?" → respuesta fija (`faq.ts` `pidePedidoPorWeb`, antes de las FAQ por puntaje y del agente): *"Sí, podés hacer el pedido directo en la web: entrá a loekemeyer.com › Pedidos Mayorista con tu CUIT y tu clave. Ahí ves los precios al día y, por hacerlo por la web, tenés un descuento extra que se aplica solo al armar el pedido."* No dice cuánto es (hoy el 2 % web, que por WhatsApp no aplica) ni promete "mismos precios": el precio del cliente es la lista menos su descuento por volumen. Hace falta "puedo / podemos / se puede…" + pedir o hacer el pedido + la web (o la página, el sitio, online); no cuenta quien no puede (clave, usuario, error: acceso a la web), quien lo manda por WhatsApp, mail o acá, ni quien nombra el cotizador (m41). Sin alerta; sólo clientes.

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

## Flujo 7: Cliente que escribe fuera del horario de atención (06/10/2026)

El bot contesta las 24 horas. Lo que cambia fuera del horario telefónico (por defecto lunes a viernes de 9 a 17 h, editable en
Configuración › Derivaciones) es qué se le dice al cliente cuando su consulta queda esperando a una persona:

```
CLIENTE (sábado 11:00): Me llegó la mercadería rota
BOT: Lamentamos lo ocurrido… (respuesta de siempre; la consulta se deriva y abre tarea en Planify)
BOT: Ahora estamos fuera del horario de atención (lunes a viernes de 9 a 17 h). Tu consulta quedó
     registrada y te respondemos el lunes desde las 9 h.
```

- El aviso lo manda `_shared/fuera-de-horario.ts` DESPUÉS de procesar el mensaje: dentro de horario no hace nada ni consulta la base;
  fuera de horario mira si ese turno dejó una alerta que espera a una persona (no avisa de comprobantes, adjuntos ni fallas de la IA) y
  manda UN mensaje aparte, una vez cada 12 h por número.
- Los feriados salen del calendario de Planify (`planify.feriados`, se leen solos); un lunes feriado cuenta como fuera de horario y el aviso dice "el martes desde las 9 h".
- Los tiempos de respuesta del semáforo (🔴 20 min · 🟡 2 h · 🟢 4 h) cuentan sólo dentro del horario: una alerta 🔴 del viernes 16:50
  vence el lunes 9:10 (`_shared/horario.ts`, `sumarMinutosHabiles`).
- Si una persona le contesta pasadas las 24 h del último mensaje del cliente, WhatsApp sólo deja mandar una plantilla: botón
  **Reabrir con plantilla** de Centro de mensajes (plantilla `retomar_consulta`). La plantilla no abre la ventana: la abre la respuesta del
  cliente o el botón «Retomar consulta».

```
PERSONA (lunes 9:30, ventana cerrada): [Reabrir con plantilla]
BOT/PLANTILLA: Hola {razón social}, te escribimos de Loekemeyer por la consulta que nos hiciste.
     Retomamos la conversación: respondé este mensaje o tocá el botón y seguimos por acá.
     [botón: Retomar consulta]
```

## Manejo de errores

```
CLIENTE: asdf
BOT: No entendí. Podés preguntarme por:
     📦 Estado de pedidos
     🛒 Hacer un pedido
     💬 O escribime tu consulta y te ayudo
```

### Tope de consultas de IA por hora (Pablo, 06/10/2026, `_shared/tope-ia.ts`)

El contador (`wa_check_rate_limit`) cuenta por **hora de reloj** y sólo los mensajes que llegan al agente de IA (no las respuestas fijas ni los flujos): por defecto 20 por número y hora.
Al mensaje 21 el bot **no llama a la IA** y, una sola vez por hora y número:
1. **Le avisa al cliente cuánto esperar**, con la hora en que se reinicia (editable en el Panel › Rate Limit, variables `{{limite}}`, `{{espera}}`, `{{hora}}`):
   *"Recibimos muchas consultas seguidas desde este número (el máximo es 20 por hora), así que hacemos una pausa. Podés volver a escribirnos en 45 minutos, a partir de las 15:00. Si fue sin querer, no te preocupes: se reactiva solo."*
2. **Deja una alerta para una persona** (motivo `tope_ia`, semáforo amarillo, va a Planify según Configuración › Derivaciones) con el último mensaje del cliente: puede haber sido un error suyo
   (mensajes repetidos, un loop del teléfono) o una consulta real que quedó sin contestar.
El resto de esa hora el bot no contesta a ese número (sin más avisos, para no generar más tráfico del que corta).

## Opt-out

```
CLIENTE: No quiero recibir más mensajes
BOT: Listo, no te vamos a enviar más notificaciones.
     Si cambiás de opinión, escribinos cuando quieras.
```
