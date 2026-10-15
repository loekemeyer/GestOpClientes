-- Rollback de sql/162: vuelve a poner la razón social al inicio de wa_faq #8 y #42.
update public.wa_faq
   set bot_response = replace(bot_response, 'Tus descuentos son:', '{{nombre_cliente}}, tus descuentos son:'),
       updated_at = now()
 where id = 8
   and bot_response like 'Tus descuentos son:%';

update public.wa_faq
   set bot_response = replace(bot_response, 'Estos son los datos para transferir:', '{{nombre_cliente}}, estos son los datos para transferir:'),
       updated_at = now()
 where id = 42
   and bot_response like 'Estos son los datos para transferir:%';
