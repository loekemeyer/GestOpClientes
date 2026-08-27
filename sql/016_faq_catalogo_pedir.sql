-- Actualiza respuesta de FAQ "Pedir catálogo"
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
-- Solicitado en sesión Mel 27/8 — nuevo copy para catálogo con URL

UPDATE wa_faq
SET bot_response = E'📘 El catálogo está disponible en loekemeyer.com\n\nPodés descargarlo directamente desde la página web, en la sección inferior.\n\n¿Te lo enviamos por acá también si preferís?'
WHERE category = 'catalogo_novedades';
