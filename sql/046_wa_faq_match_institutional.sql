-- 046_wa_faq_match_institutional.sql
-- Amplia la RPC wa_faq_match para exponer `institutional_response` — la
-- variante "no cliente" (frío/institucional) de cada FAQ. El bot elige
-- entre bot_response (para clientes identificados) y institutional_response
-- (para consultas sin cliente detrás) en tiempo de ejecución.
--
-- Idempotente: `drop function` + `create` porque cambia la firma de la
-- tabla de retorno (Postgres no permite alterar returns con `create or
-- replace`).

DROP FUNCTION IF EXISTS wa_faq_match(text);

CREATE OR REPLACE FUNCTION wa_faq_match(p_text text)
RETURNS TABLE (
  faq_id                 bigint,
  category               text,
  subcategory            text,
  automation_level       text,
  bot_response           text,
  institutional_response text,
  web_first_response     text,
  fallback_label         text,
  requires_db_lookup     boolean,
  db_lookup_type         text,
  requires_product_match boolean,
  match_score            int
) AS $$
BEGIN
  RETURN QUERY
    SELECT
      f.id AS faq_id,
      f.category,
      f.subcategory,
      f.automation_level,
      f.bot_response,
      f.institutional_response,
      f.web_first_response,
      f.fallback_label,
      f.requires_db_lookup,
      f.db_lookup_type,
      f.requires_product_match,
      (
        SELECT count(*)::int
          FROM unnest(f.keywords) AS kw
         WHERE lower(p_text) LIKE '%' || lower(kw) || '%'
      ) AS match_score
    FROM wa_faq f
    WHERE f.is_active = true
    ORDER BY match_score DESC, f.priority DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION wa_faq_match(text) IS
  'Busca FAQ por keywords. Devuelve top 5 incluyendo bot_response (para clientes) e institutional_response (para no clientes) — el bot elige cuál según haya identificado al cliente.';
