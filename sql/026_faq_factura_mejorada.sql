-- Actualiza FAQ #10 "Facturación" con respuesta más completa y orientada a self-service
-- Incluye cómo descargar, cuándo llega, y qué hacer si no llegó
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Podés descargar tus facturas y remitos directamente desde la web: 🧾\n🔗 loekemeyer.com → "Mis Pedidos" → "Comprobantes"\n\nSi necesitás tu usuario, avisame. 😊\n\nLa factura se envía por mail el día que sale tu pedido (revisá la carpeta de spam). La mercadería viaja solo con remito.\n\nSi no te llegó, pasame tu CUIT o N° de pedido y la reenviamos. 📧'
WHERE id = 10;
