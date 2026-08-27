-- Actualiza FAQ #10 "Facturación" - respuesta AUTO simple
-- El bot devuelve SOLO bot_response (web_first es solo para web)
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET
  bot_response = E'La factura se envía por mail el día que sale tu pedido (revisá la carpeta de spam). La mercadería viaja solo con remito.\n\nSi no te llegó, pasame tu CUIT o N° de pedido y la reenviamos. 📧'
WHERE id = 10;
