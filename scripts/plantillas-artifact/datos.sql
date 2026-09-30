-- Paso 2 de LEEME.md: arma datos.json a partir de la respuesta de lk_templates (paso 1) + uso de wa_outbox + la llave.
-- Reemplazar :ID por el id que devolvió el net.http_post del paso 1. Proyecto PaginaLK (kwkclwhmoygunqmlegrg). Sólo lectura.
select jsonb_build_object(
  'generado', now(),
  'llave', (select value from app_settings where key = 'wa_envio_automatico'),
  'versiones', coalesce((select value::jsonb from app_settings where key = 'wa_plantillas_version'), '{}'::jsonb),
  'plantillas', (
    select jsonb_agg(jsonb_build_object(
      'name', t->>'name', 'status', t->>'status', 'category', t->>'category', 'language', t->>'language',
      'header', (select c->>'format' from jsonb_array_elements(t->'components') c where c->>'type' = 'HEADER'),
      'header_text', (select c->>'text' from jsonb_array_elements(t->'components') c where c->>'type' = 'HEADER'),
      'body', (select c->>'text' from jsonb_array_elements(t->'components') c where c->>'type' = 'BODY'),
      'footer', (select c->>'text' from jsonb_array_elements(t->'components') c where c->>'type' = 'FOOTER'),
      'buttons', (select jsonb_agg(b->>'text') from jsonb_array_elements(t->'components') c, jsonb_array_elements(c->'buttons') b where c->>'type' = 'BUTTONS'),
      'ejemplos', (select c->'example'->'body_text'->0 from jsonb_array_elements(t->'components') c where c->>'type' = 'BODY')
    ) order by t->>'name')
    from net._http_response r, jsonb_array_elements((r.content::jsonb)->'templates') t where r.id = :ID),
  'uso', (
    select jsonb_object_agg(template_name, u) from (
      select template_name, jsonb_build_object(
        'enviados', count(*) filter (where status = 'sent'),
        'retenidos', count(*) filter (where status like 'held%'),
        'ultimo', max(created_at)::date) u
      from wa_outbox where template_name is not null and created_at > now() - interval '30 days'
      group by template_name) x)
)::text as datos;
