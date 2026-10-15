-- 159 · worklist: no mostrar las charlas SIN RESPUESTA que cayeron con el bot pausado (Pablo Olejavetzky, 15/10/2026)
--
-- v_wa_charlas_para_revisar lista las charlas derivadas o sin respuesta para darles una salida en la revisión
-- diaria. Pero una charla "sin respuesta" cuando la llave de envíos estaba en '0' (bot pausado) NO es una falla:
-- el webhook recibió y, a propósito, no contestó. Mostrarla como pendiente es ruido.
--
-- Con el registro de la llave ya andando (sql/158, trigger trg_wa_llave_log), se puede saber en qué modo estaba
-- la llave al momento de cada charla. Este cambio:
--   1) agrega la columna `llave_en` = modo de la llave vigente al `fin` de la charla (de wa_llave_cambios).
--   2) saca del worklist las `sin_respuesta` cuyo `llave_en` = '0' (bot pausado).
-- Las derivadas siempre quedan. Una `sin_respuesta` con la llave en 'prueba'/'1' (bot encendido) es una falla real
-- y se sigue mostrando. Si no hay registro de llave anterior a esa charla (`llave_en` NULL, p. ej. las de antes del
-- 15/10 cuando la tabla estaba vacía), NO se puede probar que estuvo pausada, así que se sigue mostrando a propósito.
--
-- La vista corre con derechos del dueño (sin security_invoker), así que lee wa_llave_cambios (service_role) igual.
-- Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicado (es la definición viva).

create or replace view public.v_wa_charlas_para_revisar as
 select r.telefono,
    r.charla_id,
    r.inicio,
    r.fin,
    r.estado,
    r.del_cliente,
    r.del_bot,
    cli.cod_cliente,
    cli.business_name,
    ( select a.tipo || coalesce(' · '::text || nullif("left"(a.contexto::text, 80), ''::text), ''::text)
           from wa_alertas_humano a
          where a.phone = r.telefono and a.tipo <> 'whitelist_gate'::text and a.created_at >= (r.inicio - '00:02:00'::interval) and a.created_at <= (r.fin + '00:05:00'::interval)
          order by (wa_alerta_es_derivacion(a.tipo, a.contexto)) desc, a.created_at desc
         limit 1) as motivo,
    ( select "left"(b.contenido, 160) as "left"
           from bot_historial_chat b
          where b.telefono = r.telefono and b.rol = 'user'::text and b.creado_en >= r.inicio and b.creado_en <= r.fin
          order by b.creado_en desc
         limit 1) as ultimo_cliente,
    ( select lc.modo_nuevo
           from wa_llave_cambios lc
          where lc.creado_en <= r.fin
          order by lc.creado_en desc
         limit 1) as llave_en
   from v_wa_resultado_charla r
     left join lateral ( select c.cod_cliente,
            c.business_name
           from bot_customer_whatsapps cw
             join customers c on c.id = cw.customer_id
          where regexp_replace(coalesce(cw.whatsapp, ''::text), '[^0-9]'::text, ''::text, 'g'::text) = regexp_replace(r.telefono, '[^0-9]'::text, ''::text, 'g'::text)
          order by cw.is_primary desc nulls last
         limit 1) cli on true
  where r.estado = any (array['derivada'::text, 'sin_respuesta'::text])
    -- OJO lógica de tres valores: si no hay registro de llave antes de la charla el subselect da NULL, y
    -- `NULL = '0'` es NULL, que en el WHERE descarta la fila. coalesce(...,'') hace que "sin registro" NO filtre
    -- (sólo se esconde la sin_respuesta que PROBADAMENTE cayó con la llave en '0').
    and not (r.estado = 'sin_respuesta'::text
             and coalesce(( select lc.modo_nuevo
                              from wa_llave_cambios lc
                             where lc.creado_en <= r.fin
                             order by lc.creado_en desc
                            limit 1), ''::text) = '0'::text)
  order by r.fin desc;
