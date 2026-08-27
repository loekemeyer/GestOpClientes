-- Actualiza respuesta de FAQ "Novedades / lanzamientos"
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- Solicitado en sesión Mel 27/8 — nuevo copy con URL mayorista

UPDATE wa_faq
SET bot_response = E'🆕 Todos los lanzamientos están en loekemeyer.com\n\nPara ver solo artículos nuevos:\n1️⃣ Ingresá a loekemeyer.com → "Pedidos Mayorista"\n2️⃣ Filtrá por "Nuevos" en la sección de Productos\n\nSi necesitás consultar detalles de algún producto específico, decime el código 📍'
WHERE category = 'catalogo_novedades'
  AND (subcategory = 'novedades' OR subcategory IS NULL);
