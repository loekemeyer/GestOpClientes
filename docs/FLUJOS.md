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
abiertas, la línea no sale. Código: `descuentosFacturasBlock` en `_shared/faq.ts`.

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

```
CLIENTE: ¿Cómo va mi pedido?
BOT: Tenés 2 pedidos recientes:
     1️⃣ NP-4521 (15/08) — $850.000 — 📦 Programado para 28/08
     2️⃣ NP-4490 (02/08) — $320.000 — ✅ Entregado 10/08
     ¿Necesitás más detalle de alguno?
CLIENTE: El primero
BOT: Pedido NP-4521:
     • 12 cajas Cuchillo Asado 22cm
     • 6 cajas Espátula Nylon
     • 24 cajas Cucharón Nylon
     Programado para entrega el 28/08.
```

## Flujo 3: Nuevo pedido

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
