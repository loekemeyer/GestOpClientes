-- Actualiza FAQ #19 "Pedir catálogo"
-- ID=19, category=catalogo_novedades
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Claro! Podés ver todos los productos en nuestra web, explorar el catalogo y novedades con fotos, usá el buscador o navegá por categoría:\n\n🔗 https://loekemeyer.com/\n\nSi buscás algo en particular, decime y te ayudo. 😊'
WHERE id = 19;
