-- 118 — wa_agente_evals deja de leerse con la anon key (Pablo Olejavetzky, 01/10). Sigue a sql/117.
--
-- Desde sql/117 los casos guardan la respuesta del bot simulada con un cliente real (facturas, importes, razón social).
-- La anon key viaja en docs/index.html (GitHub Pages), así que la policy de lectura de sql/058 dejaba eso público.
-- El panel ahora lee con lk_agente-modelos (action eval_list), que exige admin; el bot no lee esta tabla.
-- Aplicar DESPUÉS de que el dashboard con eval_list esté publicado: antes, la pestaña Evaluación queda vacía.

drop policy if exists wa_agente_evals_lectura on public.wa_agente_evals;
revoke select on public.wa_agente_evals from anon, authenticated;
