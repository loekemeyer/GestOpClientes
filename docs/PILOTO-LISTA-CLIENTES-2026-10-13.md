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
3. Que **el teléfono sea el actual de cada cliente.** *(Corregido el 13/10, ver `PROPUESTA-TELEFONOS-695-2026-10-13.md`: antes decía que la copia del 24/09 podía perder cambios; no está demostrado.)*
   Los 4 teléfonos del piloto están en **las dos fuentes del padrón** (la vieja y `GV_Clientes_Whatsapp`, que la reemplazó el 24/09), con el mismo cliente, y `wa_identify_customer` los reconoce.
   Ninguna de las dos tiene un cambio posterior al 24/09, así que no hay un número más nuevo que el bot no vea; lo que no se puede saber desde la base es si un cliente cambió de número y nadie lo cargó.
   Siguen sin estar en la agenda de vinculaciones (revisión humana). Confirmarlos con el vendedor antes de cargarlos sigue valiendo. Dato nuevo: **LK 1987 Bertotto tiene el mismo teléfono que el cliente
   Chef 1891**, que es el mismo negocio. El bot lo trata como un cliente con dos marcas y ese caso no se probó en el aislamiento.

## 5. Revisión de las fichas (Fase 1 punto 2, hecha el 13/10 sobre estos 4)

Ninguna ficha tiene porcentajes, teléfonos, mails ni documentos. **Actualizado el 14/10 contra el historial original** (`FICHAS-PILOTO-PROPUESTA-2026-10-14.md`, que trae
los textos exactos): lo que sigue reemplaza los hallazgos del 13/10, que eran una primera lectura de las fichas sin mirar los mensajes.

1. **3790 Schell: se propone corregir 3 líneas.** El retiro en el depósito y su horario no salen de ningún mensaje del cliente. El «7 a 15 días» es un aviso de la
   empresa del 08/10/2025, no un hábito, y el bot podría repetirlo como promesa de entrega. El «y después» de los defectuosos no sale de ningún mensaje (el historial termina el
   09/06/2026): los casos son abril y junio 2026. El acuerdo de los dos cheques pasó una sola vez (octubre 2025).
2. **3969 Rodriguez: se propone corregir 2 líneas.** La «garantía de por vida» la dijo una persona de la empresa en septiembre 2025: el bot no debería afirmarla como regla.
   El rango de cajas es de 2 a 15, no de 3 a 15.
3. **1987 Bertotto: sin cambios.** *Retirado el hallazgo del 13/10 («saldo viejo dentro de la memoria»):* las deudas de diciembre 2025 y febrero 2026 salen de dos avisos
   automáticos de la empresa y la ficha no tiene importes.
4. **3969, retirados dos hallazgos del 13/10:** (a) «Nicolás vs Jonatan, puede ser una mezcla»: Nicolás escribe desde esta cuenta y en el mismo chat da el nombre de Jonatan
   Rodríguez (09/02/2026); (b) «cheques pendientes registrados como deuda» no es un acuerdo excepcional: es la explicación de Cobranzas del 02/02/2026 y la línea de la ficha es exacta.
5. **3848 Kourvelis:** sin hallazgos de fondo (no se revisó contra el historial). «Le hablaron sobre el pago en mayo de 2026» es vago pero inofensivo.

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
