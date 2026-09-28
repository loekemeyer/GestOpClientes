# Estudio de cobertura del bot — consultas reales 28/07 → 28/09/2026

Pedido de Pablo Olejavetzky (28/09). Fuente: `chatbot_intents_whatsapp.json` (WhatsApp Business Loekemeyer,
236 contactos, 712 consultas + 108 saludos). Método: las 61 frases de ejemplo de los 15 motivos (y 5 de fuera de
alcance) pasadas por `lk_bot-simular` — cada una en una charla nueva, cliente 4210 con el teléfono de Thomy (para
que las herramientas encuentren pedidos) y las de entrega también con el cliente 4000 (expreso). 70 simulaciones,
55 llamadas a la IA, **USD 0,83**. Ningún mensaje salió a WhatsApp. Adjuntos, altas de no-clientes y fuera de
alcance real se evaluaron además leyendo el código (el simulador sólo simula clientes identificados).

Escala: ✅ resuelve bien · 🟡 parcial (responde algo útil pero incompleto o sin derivar cuando debía) · 🔴 mal
(responde otra cosa, dato falso, o manda al cliente a otro canal en vez de resolver/derivar).

## Resultado por motivo (ordenado por volumen)

| Motivo | Consultas | Estado | Qué pasa hoy |
|---|---:|:-:|---|
| Fecha / estado de entrega | 112 | 🟡 | FAQ de estado da cada pedido con fecha y modo (expreso/retiro) ✅. Si la pregunta cae en la IA y el cliente fue reconocido por teléfono del ERP, dice "no encontré pedidos" (bug, ver C). "30/09 vs 13/10" no se resuelve ni deriva. Sin fecha → no deriva. |
| Pagos: importe, CBU, comprobante | 101 | 🔴 | CBU/alias ✅. "Pasame el importe con 25 % contado" → la IA niega el descuento de contado (dice que sólo tiene 10 % + 2 %) ✖. "¿Recibieron el pago?" → responde medios de pago. Comprobante → lo manda a otro WhatsApp (Cobranzas 11 6557-4113). E-cheq → contactos externos. |
| NC, faltante o error de factura | 85 | 🔴 | Faltante con código ✅ (FAQ #35 deriva y pide fecha). "59 de 60, pido NC" → contactos externos, sin alerta. "Me facturaron dos veces" y "no me llegó la factura" → FAQ #10 (promete reenvío que no existe, pide N° de pedido). "No veo el descuento" → lista descuentos, no registra el reclamo. |
| Retiro en depósito | 78 | 🔴 | Siempre la ficha fija del depósito (FAQ #4): no mira si el pedido está listo ni desde cuándo, "el jueves lo retiro" no se registra, "estoy llegando" repregunta. |
| Lista de precios / cotizador | 67 | 🟡 | "¿Sigue vigente?" → la vigente es la de la web ✅. "Cotizador actualizado" → texto de marketing de la web (#11). Excel / códigos de barras → contactos externos. Falta [CONFIRMAR archivo]. |
| Alta de cliente nuevo | 64 | 🟡 | Para no-clientes existe el alta paso a paso + alerta + aprobar/rechazar en Tareas ✅ (código). "Mínimo de compra" → FAQ #21 ✅. Pero la IA inventó "somos fabricantes de cubiertos y cuchillería" y "registrate en la web" ✖. |
| Confirma pedido cargado en la web | 56 | 🟡 | Lo confirma con la lista de pedidos ✅. "¿Cuándo lo paso a buscar?" → ficha del depósito. Pedido no encontrado → contactos externos en vez de alerta. |
| Web: contraseña / acceso | 37 | 🟡 | Contraseña → deriva con alerta ✅ (FAQ #7). "No me deja elegir sucursal" → repregunta; "no tengo retiro" → ficha del depósito ✖. |
| Modifica artículos de un pedido | 27 | 🔴 | "Agregar 60 sacacorchos" → FAQ #21 (mínimo de compra) ✖. La IA dice "no se toman pedidos por WhatsApp" (el archivo pide registrar el cambio si no está en preparación). Sólo "anulá" deriva ✅. |
| Pedido fuera de la web (Excel, foto, texto) | 27 | 🔴 | Texto con artículos → ficha del depósito / lista de pedidos / marketing web. Adjunto real → "no enviar ningún archivo adjunto a este número" + alerta (la alerta ✅, el mensaje es hostil). |
| Stock / artículo | 27 | 🟡 | Encuentra el artículo con precio ✅. Stock pide código. "¿Cuándo ingresan los nuevos?" → web. |
| Mercadería rota o fallada | 18 | 🔴 | "Coladores rotos" → pide fecha, sin alerta. "7 unidades rotas" → FAQ #21 (mínimo de compra) ✖. Foto → mensaje de adjunto no soportado. |
| Error de carga | 7 | 🔴 | "Apreté confirmar varias veces" → la IA afirma que "la web suele evitar eso" (falso: el archivo dice que permite doble envío). Razón social equivocada → lista de pedidos ✖. "Anulá todo" ✅. |
| Cómo hacer un pedido | 6 | ✅ | Web + CUIT y contraseña. Falta el instructivo [CONFIRMAR]. |
| Saludo / gracias (no suma a las 712) | 108 | ✅ | Responde breve (usa la IA: se podría resolver sin tokens). |

**Sobre 712 consultas (sin saludos): ✅ 6 (1 %) · 🟡 363 (51 %) · 🔴 343 (48 %).**
(La suma de los motivos da 820 = 712 + 108 saludos: el archivo cuenta los saludos aparte.)

### Fuera de alcance

| Caso | Qué pasa hoy | Qué pide el archivo |
|---|---|---|
| Consumidor con producto fallado (19 contactos) | 🔴 "reclamá en el supermercado" | Número de reclamo y derivar siempre (urgente si menciona Defensa del Consumidor) |
| Consumidor que pregunta precio | 🔴 texto de marketing de la web mayorista | Explicar que es mayorista y dónde comprar [CONFIRMAR] |
| CV / empleo | 🔴 lo manda a ventas | Canal de RR. HH. [CONFIRMAR] |
| Proveedores / publicidad | 🔴 lo manda a ventas | Mail de contacto, NO a comercial [CONFIRMAR] |
| Phishing | 🟡 le contesta explicando que es estafa | No responder y avisar a una persona |

## Causas de fondo (ordenadas por impacto)

**A. La IA no puede derivar a una persona.** No tiene ninguna herramienta para crear la alerta (las 12
herramientas son de consulta). Entonces "deriva" dándole al cliente `ventas@loekemeyer.com` y el WhatsApp
11 3118-1021: pasó en ~20 de las 70 respuestas (pagos, NC, rotura, alta, pedido no encontrado, CV, proveedores).
El cliente ya está escribiendo por WhatsApp y lo mandamos a otro canal; nadie se entera. Arreglo: herramienta
`derivar_a_persona(motivo, resumen)` → `notificarHumano` (Tareas + cartel de Planify), igual que ya hacen las FAQ
`needs_human`.

**B. Respuestas fijas que se disparan por palabras sueltas.** 12 de 70: #21 (mínimo de compra) con "agregar",
"unidades", "rotas"; #4 (depósito) con cualquier "retir"; #1 (estado) con "pedido"; #11 (marketing web) con
"cotizador" o "precio"; #10 (factura) con "facturaron dos veces". Arreglo: exigir más coincidencia o mandar lo
dudoso a la IA.

**C. Cliente reconocido por el ERP → la IA no encuentra sus pedidos.** `wa_identify_customer` reconoce por
teléfono vinculado **o del ERP**; las herramientas usan `bot_cliente_por_whatsapp`, que sólo mira los vinculados.
Con clientes reales (139 de 156 facturados en el mes tienen teléfono en el ERP y ninguno vinculado) la IA diría
"no encontré pedidos en tu cuenta". Es un error de código ya publicado; hoy no se ve porque sólo contesta a Thomy.

**D. Datos que el bot no tiene:** importe a pagar / deuda (ya existe `GV_Cobranza_Deuda_Viva`, usada en la
ficha), si llegó un pago (imputaciones de Cobranzas), reenvío de factura (flujo de facturas en prueba), si un
pedido de retiro ya está listo (el estado existe; la ficha del depósito no lo usa).

**E. Datos falsos en el prompt / textos:** "fabricantes de cubiertos y cuchillería"; niega el descuento de
contado; política de garantía al consumidor; mensaje hostil de adjuntos; números de WhatsApp externos.

**F. Pendientes del negocio ([CONFIRMAR] del archivo):** instructivo de pedido, archivo de lista vigente,
horario/almuerzo del depósito, canal de RR. HH., mail de proveedores, proceso de garantía al consumidor, reglas
de descuento por pago.
