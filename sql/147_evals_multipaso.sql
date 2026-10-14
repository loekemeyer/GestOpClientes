-- 147 · casos de evaluación de VARIOS PASOS (Pablo Olejavetzky, 14/10/2026, P5 del plan de los 8 puntos)
--
-- Hasta hoy casi todos los casos de wa_agente_evals eran de 1 o 2 herramientas. P5 (planificación) pide probar
-- consultas que necesitan varios pasos en un mismo turno: mirar con una herramienta, después cambiar o derivar, y
-- sólo preguntar lo que ninguna herramienta puede decir. Estos 8 casos (clave mp01..mp08, origen 'multipaso') corren
-- solos cada noche en el Simulador con Gemini gratis (lk_eval-corrida) y se comparan con la corrida anterior.
--
-- La barrera real de la planificación es la regla "ANTES DE ACTUAR" de _shared/agente-fijos.ts (REGLAS_OPERATIVAS);
-- estos casos miden que el agente la cumpla, no son la regla.
--
-- Idempotente (re-seed por origen). Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg).

delete from public.wa_agente_evals where origen = 'multipaso';

insert into public.wa_agente_evals (clave, tipo, origen, pregunta, nota_esperada, activo, estado) values
('mp01','multipaso','multipaso','¿Tenés stock del 505 y a qué precio me queda con mi descuento?','Dos pasos en el mismo turno: consultar_stock del 505 y el precio con el descuento del cliente (consultar_mis_descuentos o el precio que ya trae su contexto). Responde las dos cosas, sin inventar números ni calcular el descuento por su cuenta.',true,'pendiente'),
('mp02','multipaso','multipaso','Agregá 2 cajas del 505 a mi último pedido y decime cuándo llega','Mira consultar_mis_pedidos, toma el más reciente que todavía no salió y lo nombra por su fecha, confirma código, cajas y pedido para el agregado, y en el mismo turno responde la entrega con consultar_mi_entrega. No deja una de las dos partes sin responder.',true,'pendiente'),
('mp03','multipaso','multipaso','Anulá el pedido y hacelo de nuevo con 10 cajas','No anula solo. Identifica el pedido reciente no salido con consultar_mis_pedidos, deriva la anulación con derivar_a_persona (motivo anulacion_pedido, urgente) en ese turno, y encamina el pedido nuevo (por ahora a la web, o lo toma si se toman pedidos por WhatsApp). Hace las dos cosas, no sólo una.',true,'pendiente'),
('mp04','multipaso','multipaso','¿Cuándo llega mi pedido y cuánto tengo que pagar?','Dos consultas en el mismo turno: consultar_mi_entrega para la entrega y consultar_mis_facturas para el importe. Responde las dos, sin inventar fechas ni importes.',true,'pendiente'),
('mp05','multipaso','multipaso','Pasame la foto del 441 y decime si hay stock','buscar_productos para la foto del 441 y consultar_stock para el stock, en el mismo turno. Pasa el link de la foto pelado y el stock como lo dice la herramienta, sin números.',true,'pendiente'),
('mp06','multipaso','multipaso','Del pedido de ayer sacá la paleta batidora y sumá 3 cajas del batidor pera','Sacar y sumar en el mismo mensaje es un cambio, no un agregado: no usa solicitar_agregado_pedido. Toma el pedido reciente no salido, lo nombra por su fecha y deriva con derivar_a_persona (motivo cambio_pedido) en ese mismo turno con el detalle de qué saca y qué suma.',true,'pendiente'),
('mp07','multipaso','multipaso','¿Qué pedidos tengo pendientes y cuándo sale cada uno?','Un solo consultar_mis_pedidos y arma la respuesta: lista cada pedido pendiente por su fecha, con su estado y, si está programado o facturado, cuándo sale. Si alguno no tiene fecha, lo dice así, sin inventar plazos.',true,'pendiente'),
('mp08','multipaso','multipaso','Pasame el precio del 505, del 441 y del 067','Busca los tres con buscar_productos y responde los tres precios en el mismo turno (o avisa cuál no está disponible). No pregunta a cuál se refiere ni pide que los mande de a uno.',true,'pendiente');
