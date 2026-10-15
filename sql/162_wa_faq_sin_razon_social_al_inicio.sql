-- 162 — Las respuestas fijas wa_faq #8 (descuentos) y #42 (datos para transferir) ya no empiezan con la razón social del cliente
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-10-15 · Pablo Olejavetzky · tarea de Planify 5926 (mensaje 1 de la tanda de pruebas)
-- APLICADA EN VIVO el 15/10 (un UPDATE de 1 fila por respuesta, verificado con un SELECT y con el Simulador).
--
-- Antes: «{{nombre_cliente}}, tus descuentos son:» y «{{nombre_cliente}}, estos son los datos para transferir:». La base sólo tiene la razón social
-- (muchas son personas con el apellido primero, «Quispe Gabriel Dario Josue»). Después de sql/161 (saludo #41 sin nombre) eran las dos únicas respuestas fijas
-- activas de wa_faq que arrancaban con el token (medido: 0 filas activas con bot_response que empiece con {{nombre_cliente}} después de este cambio).
-- Cambia sólo la primera frase: el resto del texto queda byte a byte igual (replace). #42 queda igual al texto del no-cliente (institutional_response).
-- En el código (_shared/faq.ts) se sacó lo mismo de las dos variantes de #8 que arma el código: «Tu última factura:» y el texto por defecto «Tus descuentos son:».
--
-- Rollback: sql/rollback/162_wa_faq_sin_razon_social_al_inicio.sql

update public.wa_faq
   set bot_response = replace(bot_response, '{{nombre_cliente}}, tus descuentos son:', 'Tus descuentos son:'),
       updated_at = now()
 where id = 8
   and bot_response like '{{nombre_cliente}}, tus descuentos son:%';

update public.wa_faq
   set bot_response = replace(bot_response, '{{nombre_cliente}}, estos son los datos para transferir:', 'Estos son los datos para transferir:'),
       updated_at = now()
 where id = 42
   and bot_response like '{{nombre_cliente}}, estos son los datos para transferir:%';
