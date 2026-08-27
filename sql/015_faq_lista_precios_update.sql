-- Actualiza respuesta de FAQ "Lista de precios / página web"
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- Solicitado en sesión Mel 27/8 — nuevo copy institucional para lista de precios

UPDATE wa_faq
SET bot_response = E'Estimados clientes,\n\nA través de Loekemeyer.com podrán ver la lista de precios, catalogo, gestionar su reposición con mayor facilidad, acceder a nuevos productos, consultar su historial de compras desde 2020 en adelante y repetir pedidos en un solo paso, sugerencias de compras por IA, entre otras funcionalidades.\n\nPara acceder, ingresen a Loekemeyer.com, hagan clic en "Pedidos Mayorista" e inicien sesión con su CUIT y contraseña, si no las tenes avisanos y te ayudamos 🌐\n\nSaludos cordiales,\nEquipo Loekemeyer'
WHERE category = 'precios_lista'
  AND subcategory = 'consultar_precios';
