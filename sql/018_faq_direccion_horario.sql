-- Actualiza respuesta de FAQ "Dirección / horario del depósito"
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- Solicitado en sesión Mel 27/8 — confirmar ubicación y horarios

UPDATE wa_faq
SET bot_response = E'📍 *Dirección de retiro:*\nVirgilio 2788, Villa Devoto, CABA\n\n🕐 *Horario de atención:*\nLunes a viernes: 10:00 a 12:00 y 13:00 a 16:00\n\n⚠️ Si no retirás en la fecha acordada, el pedido se desarma al día siguiente.'
WHERE category = 'retiro_deposito'
  AND subcategory = 'direccion';
