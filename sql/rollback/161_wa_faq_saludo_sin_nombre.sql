-- Rollback de sql/161: vuelve el saludo de wa_faq #41 a la versión con razón social.
update public.wa_faq
   set bot_response = '¡Hola {{nombre_cliente}}! ¿En qué te puedo ayudar?',
       notes = 'Saludo sin request. Cliente → saluda por nombre. No-cliente → pide CUIT (mismo copy que handleRegistration).',
       updated_at = now()
 where id = 41
   and bot_response = '¡Hola! ¿En qué te puedo ayudar?';
