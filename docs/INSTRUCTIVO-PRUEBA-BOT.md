# Instructivo para probar el bot por WhatsApp

Pedido de Damián (dueño de Loekemeyer y de Chef S.R.L.) a Pablo Olejavetzky, 08/10/2026: *"un instructivo de cómo tiene que
hacer para probar el bot"*. Abajo está el mensaje que se le armó para mandarle por WhatsApp y los datos de los que sale, para
reusarlo con otra persona que pruebe sin volver a buscarlos. **Los datos son del 08/10 y algunos ya cambiaron (marcado abajo):
antes de reenviarlo, correr el SQL de "Cómo verificarlo".**

## Número del bot

- **El bot es el +54 9 11 6864-8618** (`wa.me/5491168648618`). Sale de `app_settings.wa_phone_number_id = 918089688061759`
  y de `wa_message_status.display_phone_number`: todo lo que les llegó a Damián y a Thomy desde el 28/09 salió de ese número.
- **El +54 9 11 3118-1173 NO es el bot** (`phone_number_id` 1161138747085607). También aparece en `wa_message_status`
  (239 estados hasta el 07/10), pero el bot no lo usa. No se averiguó de qué es. Si alguien lo tiene agendado como
  "Loekemeyer", le escribe al número equivocado.

## Quién puede probar

- El bot sólo le contesta a la lista blanca (`wa_bot_solo_whitelist = 1`, tabla `wa_envio_contactos`). Al 08/10: Thomy y
  Damián. **Al 15/10 también Logística** (`5491131181027`). Sumar a alguien es cargar una fila ahí, y eso lo aprueban Luis o
  Thomas (principio de la vasectomía en `CLAUDE.md`).
- Damián prueba sobre una cuenta **real**: su número está vinculado a **Chef S.R.L., cliente 411 de Loekemeyer**
  (`bot_customer_whatsapps` id 226). El mismo CUIT es también el cliente 2 de Chef, así que el bot puede preguntar
  "¿Loekemeyer o Chef?". Al 08/10 esa cuenta tenía **0 pedidos web** y **2 direcciones de entrega**: "¿cuándo llega mi
  pedido?" contesta que no ve ninguno, y un pedido por WhatsApp pregunta para cuál dirección es.

## Qué dispara una prueba (avisarle al equipo)

- **Pedido por WhatsApp:** está prendido en modo `precarga` (`app_settings.wa_pedidos_config`). Con el "sí" del cliente queda
  una precarga y una tarea "Pedido por WhatsApp" con *Confirmar y enviar a Gestión* / *Descartar*. No llega a Gestión sola:
  **las de prueba se descartan**.
- **Reclamo** ("me llegó mercadería rota") y cualquier derivación: abre una tarea real en Planify para el sector que
  corresponda.
- **Límites que va a ver:** 20 consultas de IA por hora y por número (después pausa y avisa hasta qué hora); tope de gasto
  diario de IA (al 08/10: aviso US$ 1, tope US$ 2; **al 15/10: aviso US$ 2,5, tope US$ 3**, `ia_aviso_gasto_usd` /
  `ia_tope_gasto_usd`); fuera de horario (lunes a viernes de 9 a 17) contesta igual pero avisa que una persona responde el
  próximo día hábil.
- El 08/10 se dijo que con Sonnet como modelo principal el tope de US$ 2 eran unos 20 turnos por día y que una tanda de pruebas
  podía cortarlo. **Ya no aplica igual:** desde el 13/10 el #1 de la cadena es Haiku 5.5 (Sonnet 4.6 es el #2) y el tope
  es US$ 3.

## Mensaje que se le mandó (versión corta, 08/10)

```
Hola Damián, así probás el bot 👇

📱 Escribí al *+54 9 11 6864-8618* (wa.me/5491168648618). Te reconoce como *Chef S.R.L. (cliente 411)*.

Escribí como un cliente, por ejemplo:
1. "Hola"
2. "¿Cuándo llega mi pedido?" (la cuenta no tiene pedidos web: va a decir que no ve ninguno)
3. "¿Cuánto sale el 501?" / "Mandame foto del 505"
4. "¿Cuánto debo?" / "Mandame la factura"
5. "Quiero 2 cajas del 501": arma el pedido completo, pero *no pasa a Gestión* hasta que lo confirmemos nosotros
6. "Me llegó mercadería rota": le abre una tarea al equipo

Si te pregunta "¿Loekemeyer o Chef?", elegí cualquiera.
Con muchas consultas seguidas hace una pausa y te avisa, se reactiva solo.

Si algo no te convence, mandame la captura y qué esperabas que contestara.
```

Para otra persona: cambiar el nombre, la cuenta a la que está vinculado su número y el punto 2 si esa cuenta sí tiene pedidos.

## Cómo verificarlo antes de reenviarlo

```sql
select (select string_agg(label || ' ' || phone, ' | ' order by created_at) from public.wa_envio_contactos) as whitelist,
       (select string_agg(key || '=' || left(value, 60), ' | ') from public.app_settings
         where key in ('wa_phone_number_id', 'wa_bot_solo_whitelist', 'wa_envio_automatico', 'wa_pedidos_config',
                       'ia_tope_gasto_usd', 'ia_aviso_gasto_usd')) as config;
```
