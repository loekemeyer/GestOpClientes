-- Actualiza FAQ #4 "Dirección / horario"
-- ID=4, category=retiro_deposito, subcategory=direccion
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET bot_response = E'Nuestro depósito se encuentra ubicado en:\n\n📫 Dirección: Virgilio 2788, Villa Devoto\n\n🕐 Horario de atención: Lunes a Viernes de 10 a 12hs y 13 a 16hs\n\n🌐 Web: loekemeyer.com.ar'
WHERE id = 4;
