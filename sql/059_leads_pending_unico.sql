-- 059 — Un solo alta abierta por teléfono (punto 11c de la auditoría del 2026-09-07)
--
-- EL PROBLEMA
-- ===========
-- `sql/013` crea un índice común sobre `wa_prospect_leads(phone)`, **sin unique**. Nada impedía
-- dos filas `pending` del mismo teléfono. Y `getPendingLead` las buscaba con `.maybeSingle()`,
-- que con dos resultados devuelve `null` + un error `PGRST116` que el código ignoraba.
--
-- El efecto era el peor posible: el paso que intercepta el alta en curso **no se activaba
-- nunca**, así que el bot contestaba *"pasame tu CUIT"* en loop, para siempre, sin forma de
-- salir salvo el `RE_ALTA_CANCEL`. Un cliente nuevo quedaba trabado sin que nadie se enterara.
--
-- LA SOLUCIÓN
-- ===========
-- Índice único PARCIAL: un teléfono puede tener muchas filas históricas (aprobadas,
-- rechazadas, canceladas), pero **una sola abierta**. El parcial es la clave: un unique liso
-- sobre `phone` impediría que un cliente se dé de alta dos veces en su vida.
--
-- El código acompaña (`lk_whatsapp-webhook`):
--   · `getPendingLead` pasa a `order(updated_at desc).limit(1)` y loguea el error en vez de
--     tragárselo — tiene que aguantar filas duplicadas que ya existan.
--   · `crearLead` es idempotente: mira si ya hay una abierta, y trata el 23505 como "ya está".
--
-- MEDIDO ANTES DE APLICAR: 0 teléfonos con más de un `pending`, así que el índice entra sin
-- tener que limpiar nada. Si en el futuro fallara al crearse, es que aparecieron duplicados:
--   select phone, count(*) from public.wa_prospect_leads where status='pending'
--    group by 1 having count(*) > 1;
--
-- ROLLBACK
--   drop index if exists public.wa_prospect_leads_pending_unico;

create unique index if not exists wa_prospect_leads_pending_unico
  on public.wa_prospect_leads (phone)
  where status = 'pending';

comment on index public.wa_prospect_leads_pending_unico is
  'Un alta abierta por teléfono. Parcial a propósito: el histórico puede tener muchas filas del '
  'mismo número, pero dos pending dejaban el alta en loop infinito (auditoría 2026-09-07).';
