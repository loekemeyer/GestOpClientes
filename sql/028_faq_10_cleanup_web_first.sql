-- Limpiar web_first_response de FAQ #10 para que NO se concatene
-- El bot no debe enviar la parte de "descargar desde web"
-- Solo bot_response debe ir
-- Aplica en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET web_first_response = NULL
WHERE id = 10;
