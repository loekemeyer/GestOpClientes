-- Recategoriza FAQ #4 "Dirección/horario" de AUTO a SEMI-AUTO
-- El bot DEBE buscar la fecha programada del pedido en Supabase
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET automation_level = 'semi_auto',
    requires_db_lookup = true,
    db_lookup_type = 'order_status',
    bot_response = E'Nuestro depósito se encuentra ubicado en:\n\n📫 Dirección: Virgilio 2788, Villa Devoto, CABA\n\n🕐 Horario de atención: Lunes a Viernes de 10 a 12hs y 13 a 16hs\n\n🌐 Web: loekemeyer.com.ar\n\nTu pedido está programado para: [fecha_programada]\n\n⚠️ Si no retirás en la fecha acordada, el pedido se desarma al día siguiente.'
WHERE id = 4;
