# Flujos conversacionales — BotWA-LK

## Flujo 1: Primer contacto (vinculación)

```
CLIENTE: Hola
BOT: ¡Hola! Soy el asistente de Loekemeyer. Para poder ayudarte, necesito
     identificarte. ¿Me pasás tu código de cliente o tu CUIT?
CLIENTE: 1234
BOT: ¡Hola {nombre_empresa}! Ya quedaste vinculado a este número.
     Podés consultarme por:
     📦 Estado de tus pedidos
     🛒 Hacer un pedido nuevo
     🚚 Saber si podés pasar a retirar
     💬 Cualquier otra consulta
```

## Flujo 2: Consulta de pedido

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
