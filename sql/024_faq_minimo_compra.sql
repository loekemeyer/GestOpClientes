-- Actualiza FAQ #21 "Mínimo de compra" con nueva respuesta detallada
-- Especifica montos diferentes para entrega vs retiro
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Estimado cliente:\nLe comentamos que los pedidos que no llegan al monto mínimo de compra, que es de $500.000\nÚnicamente serán procesados si lo pasan a retirar, favor de confirmar en caso de que quieran que lo procesemos.\n\nLe recordamos que los pedidos se retirar por Virgilio 2788 en el horario de 13 a 16hs\n\nEn caso de que puedan retirarlo el mínimo es de $300.000\n\nSaludos cordiales,\nDepto. Ventas'
WHERE id = 21;
