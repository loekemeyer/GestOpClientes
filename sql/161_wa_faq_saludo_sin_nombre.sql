-- 161 — La respuesta fija del saludo (wa_faq #41, saludo_inicial) ya no dice la razón social: «¡Hola! ¿En qué te puedo ayudar?»
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-10-15 · Pablo Olejavetzky · tarea de Planify 5926 (mensaje 1 de la tanda de pruebas)
-- APLICADA EN VIVO el 15/10 (UPDATE de 1 fila, verificado con un SELECT y con el Simulador: «Hola» → via faq (full_auto #41), gasto US$ 0).
--
-- Antes: «¡Hola {{nombre_cliente}}! ¿En qué te puedo ayudar?». La base sólo tiene la razón social (1.264 clientes: 35 % con sigla de empresa y casi todo el resto
-- personas con el apellido primero, «Quispe Gabriel Dario Josue»). El saludo del primer contacto del día ya era «¡Hola!» sin nombre (webhook, commit 4e0d158) y esta
-- respuesta fija era el otro lugar donde el cliente recibía su razón social. Sólo cambia el texto del cliente: el del no-cliente (institutional_response) no se toca.
-- La respuesta ya arranca con «¡Hola», así que el webhook no le antepone un segundo saludo (faq.yaSaluda).
-- No se tocan #8 (descuentos) ni #42 (datos de transferencia), que empiezan con «{{nombre_cliente}}, …»: no son saludos y decidirlo queda aparte.
--
-- Rollback: sql/rollback/161_wa_faq_saludo_sin_nombre.sql

update public.wa_faq
   set bot_response = '¡Hola! ¿En qué te puedo ayudar?',
       notes = 'Saludo sin request. Cliente: ¡Hola! sin nombre (Pablo, 15/10: la base solo tiene la razón social y muchas son personas con el apellido primero). No-cliente: pide CUIT (mismo copy que handleRegistration).',
       updated_at = now()
 where id = 41
   and bot_response = '¡Hola {{nombre_cliente}}! ¿En qué te puedo ayudar?';
