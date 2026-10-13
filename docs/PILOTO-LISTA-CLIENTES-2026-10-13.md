# Piloto del bot: lista de clientes para aprobación (decisión 1)

> **BORRADOR. No se envió a Luis ni a Thomas.** Pablo Olejavetzky, 13/10/2026: *«Sí, armala, pero no lo mandes aún»*.
> Datos leídos el 13/10 de PaginaLK (`wa_memoria_cliente`, `orders`, `customers`, `wa_clientes_telefono`,
> `bot_customer_whatsapps`) con consultas de solo lectura. No se cargó ningún teléfono ni se tocó ninguna llave: la regla de no
> contactar a nadie (`CLAUDE.md`, vasectomía) exige que el visto sea de Luis o de Thomas antes de cargar nada.
> Decisión 1 de [`PLAN-PRODUCCION-2026-10-13.md`](PLAN-PRODUCCION-2026-10-13.md). Tope real: **viernes 16/10**.

## 1. Qué se les pide aprobar

1. **Los clientes de la lista de abajo.** El bot les contesta por WhatsApp (Haiku 5.5, con Sonnet 4.6 de respaldo).
2. **Que los avisos automáticos también les lleguen.** La llave `wa_envio_automatico` sigue en `prueba`: con ella los avisos de pedidos
   y facturas salen solo a los números de la whitelist, así que los del piloto los reciben (el plan, Fase 2 punto 1).
3. **Que los pedidos que arme el bot pasen por revisión humana** (precarga, no pedido directo) durante el piloto.

## 2. Lista propuesta (4 clientes, por monto de los últimos 90 días, mayor a menor)

Pedidos y monto: tabla `orders` de los últimos 90 días al 13/10, todos los estados. Mensajes: los de la ficha de memoria.

1. **LK 1987 Bertotto Adrian Ariel**: 5 pedidos, $ 1.455.697. Ficha de 196 mensajes (06/2025 a 06/2026). Vendedor 7. Teléfono cargado.
2. **LK 3790 Schell Lucas Maximiliano**: 4 pedidos, $ 1.426.811. Ficha de 133 mensajes. Vendedor 4. Teléfono cargado.
3. **LK 3969 Rodriguez Jonatan**: 9 pedidos, $ 1.387.515. Ficha de 134 mensajes. Vendedor 7. Teléfono cargado.
4. **LK 3848 Kourvelis SA en Formación**: 3 pedidos, $ 978.403. Ficha de 183 mensajes. Vendedor 7. Teléfono cargado.

Ninguno de los 4 comparte teléfono con otro cliente (verificado en `wa_clientes_telefono` y `bot_customer_whatsapps`).

**Damián (LK 411 Chef S.R.L.) ya está en la whitelist**, aprobado por Thomas el 02/10. Se lo deja aparte porque **no cumple el criterio del plan**:
no tiene ficha de memoria (ni LK ni CH) y tiene 0 pedidos en los últimos 90 días. Con él serían 5, el tope del plan (3 a 5).
**Pregunta para Luis o Thomas:** ¿Damián cuenta como uno del piloto o sigue como caso aparte?

## 3. Quedaron afuera, y por qué

1. **LK 288 Torres y Liva:** $ 36.550.426 en 90 días. Un error con un cliente de ese monto cuesta demasiado para un piloto.
2. **LK 4157 MRG Soluciones Comerciales:** su teléfono está cargado en 2 clientes más. Es el riesgo de mezclar clientes que la Fase 0 punto 2 todavía no cerró.
3. **LK 2191 Romagessi Antonio:** 225 mensajes y 4 pedidos ($ 4.853.849), pero no tiene teléfono cargado.
4. **LK 4028 Bazar Farimar:** tiene asociado, de forma temporal, el teléfono del canal de prueba (Thomy).
5. **LK 4210 Garbarino Franco Tomas:** reserva si algún cliente cae. 19 pedidos y $ 8.253.496 en 90 días, pero solo 65 mensajes de ficha y más volumen que el resto.

## 4. Lo que los datos no dicen

El historial de WhatsApp termina el 09/06/2026, así que dos criterios del plan **no se pueden medir con la base** y los tiene que confirmar
quien conoce al cliente (hoy, el vendedor 7 para tres de los cuatro):

1. Que **compra por WhatsApp** (la tabla `orders` no registra el canal).
2. Que **tiene un contacto que responde** rápido.
3. Que **el teléfono sea el actual de cada cliente.** Los 4 teléfonos del piloto salen **sólo** de `wa_clientes_telefono`, una copia del padrón que **no se actualiza desde el
   24/09** (0 filas tocadas en los últimos 3 días, medido el 13/10; auditoría 695). Ninguno está en la agenda de vinculaciones (`bot_customer_whatsapps`), que sí pasó por revisión
   humana. `wa_identify_customer` los reconoce bien hoy, pero un número cambiado después del 24/09 no se vería. Hay que confirmarlos con el vendedor antes de cargarlos en la whitelist.

## 5. Revisión de las fichas (Fase 1 punto 2, hecha el 13/10 sobre estos 4)

Ninguna ficha tiene porcentajes, teléfonos, mails ni documentos. Lo que sí hay que mirar antes de que las lea el agente:

1. **3790 Schell:** dice «Productos defectuosos (junio 2026 y después)». El historial termina el 09/06/2026, así que «y después» no sale de
   ningún mensaje: es una afirmación sin respaldo. Además fija una «demora habitual entre 7 y 15 días», que el bot podría repetir como promesa de entrega.
2. **3969 Rodriguez:** el cliente figura como Jonatan pero la ficha dice «Nicolás, de Nuevo Haedo». Puede ser otra persona del mismo negocio o una
   mezcla: confirmar que el teléfono cargado es el de quien escribe. Menciona «garantía de por vida» con nota de crédito, que el bot no debería afirmar.
3. **1987 Bertotto:** relata deudas de diciembre 2025 y febrero 2026 regularizadas con Cobranzas. Es un dato de saldo viejo dentro de la memoria:
   los saldos se consultan en su fuente (plan, sección 7), no se recuerdan.
4. **3790 y 3969** además cuentan acuerdos de pago excepcionales (cheques fuera de plazo, cheques pendientes registrados como deuda): el bot no
   tiene que tomarlos como derecho vigente.
5. **3848 Kourvelis:** sin hallazgos de fondo. «Le hablaron sobre el pago en mayo de 2026» es vago pero inofensivo.

## 6. Cómo se corta si algo sale mal

1. **Pausa total del bot:** `update app_settings set value = '1' where key = 'wa_bot_pausa'`. Ensayada en la base real el 13/10 (`docs/ESTADO.md`).
2. **Sacar a un cliente de la whitelist:** borrado en `wa_envio_contactos` (pide el sí de Pablo con el SQL exacto antes).
3. **Avisos automáticos:** `wa_envio_automatico = '0'` los corta todos.

## 7. Texto listo para mandar (cuando Pablo lo autorice)

> Luis, Thomas: para arrancar el piloto del bot el lunes 19/10 necesitamos su visto a estos clientes, que pasarían a hablar con el bot por WhatsApp:
> Bertotto Adrian Ariel (LK 1987), Schell Lucas Maximiliano (LK 3790), Rodriguez Jonatan (LK 3969) y Kourvelis SA en Formación (LK 3848).
> Damián de Chef S.R.L. ya está habilitado desde el 02/10: ¿cuenta como uno del piloto?
> Con la llave en `prueba`, también les llegan los avisos automáticos de pedidos y facturas. Los pedidos que arme el bot pasan por revisión humana.
> Se corta en cualquier momento con un solo cambio (`wa_bot_pausa`). Los datos de cada cliente y por qué quedaron otros afuera están en
> `docs/PILOTO-LISTA-CLIENTES-2026-10-13.md`. Si pueden responder antes del jueves 15/10 nos da margen; el tope es el viernes 16/10.
> Pendiente de confirmar con el vendedor: que cada uno compra por WhatsApp y que su contacto responde.
