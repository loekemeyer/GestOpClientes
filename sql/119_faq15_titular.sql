-- 119 — FAQ #15 (medios de pago): el titular de la cuenta es Loekemeyer Hnos. S.R.L., no "Loekemeyer S.A."
-- (Pablo Olejavetzky, 01/10). Venía de sql/018..062; el bot se lo decía a quien pedía los datos para transferir.
-- Aplicada el 01/10 y verificada con el simulador (cliente 4210, vía faq semi_auto #15). Idempotente.

update public.wa_faq
   set bot_response = replace(bot_response, 'Titular: Loekemeyer S.A.', 'Titular: Loekemeyer Hnos. S.R.L.')
 where id = 15 and bot_response like '%Titular: Loekemeyer S.A.%';
