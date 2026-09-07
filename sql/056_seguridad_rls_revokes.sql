-- 056_seguridad_rls_revokes.sql
--
-- Auditoría de seguridad del 2026-09-07. Tres agujeros, todos con la misma
-- raíz: en Postgres los permisos nacen abiertos y nadie los cerró.
--
--   (a) 15 tablas wa_*/bot_* con RLS APAGADA y `anon` con SELECT/INSERT/
--       UPDATE/DELETE. La anon key es PÚBLICA: viaja en `docs/index.html`,
--       servido por GitHub Pages. O sea que cualquiera podía leer
--       `wa_prospect_leads` (CUIT, mail, teléfono y dirección de las altas),
--       `wa_comprobantes`, `wa_alertas_humano` (con el texto que mandó el
--       cliente) y los 610 teléfonos de `wa_clientes_telefono`, y además
--       vaciar `wa_blacklist` o `wa_rate_limit`.
--
--   (b) 18 funciones wa_*/bot_* ejecutables por `anon`. La peor es
--       `bot_submit_order`, SECURITY DEFINER y sin ningún chequeo de
--       identidad: la única "autorización" es el `p_telefono` que pasa el
--       llamador, y los teléfonos salían de (a). Cadena completa: leer los
--       610 teléfonos con la anon key y crear pedidos reales a nombre de
--       cualquier cliente.
--
--   (c) La policy `service_role_all` de `product_aliases` se llama así pero
--       no restringe rol: es `roles={public}` con `USING (true)` para ALL.
--       Con los grants de `anon` sobre la tabla, cualquiera podía envenenar
--       el matching de productos (que "cuchillo" resuelva a otro código) y
--       ensuciar los pedidos que arma el agente.
--
-- ALCANCE VERIFICADO ANTES DE ESCRIBIR ESTO (por eso no rompe nada):
--   · Ninguna de estas 10 tablas ni de estas 18 funciones se toca desde el
--     navegador — ni en `docs/index.html` (que no tiene un solo `sb.rpc`) ni
--     en el sitio público de PaginaLK.
--   · Las edge functions y los crons entran con service_role, que tiene
--     BYPASSRLS y conserva el EXECUTE explícito que se re-otorga abajo.
--   · Las 5 tablas `wa_agente_*` quedan AFUERA a propósito: el dashboard las
--     lee y escribe directo con la anon key, así que prenderles RLS las
--     rompe. Primero hay que mover esas escrituras a una edge function con
--     gate de admin (patrón `lk_faq-admin`). Queda pendiente.
--
-- Idempotente: `enable row level security`, `revoke` y `grant` se pueden
-- correr de nuevo sin efecto.
--
-- ROLLBACK (si algo se rompe, deja todo como estaba):
--   alter table public.<tabla> disable row level security;
--   grant select, insert, update, delete on public.<tabla> to anon, authenticated;
--   grant execute on function public.<fn>(<args>) to public;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. RLS + cierre de grants en las 10 tablas que nadie lee desde el browser
-- ─────────────────────────────────────────────────────────────────────────
-- Sin policies, RLS deniega todo para anon/authenticated; service_role pasa
-- por BYPASSRLS. Se revocan además los grants, para que una policy futura
-- mal escrita no vuelva a abrir la tabla sola.

do $$
declare t text;
begin
  foreach t in array array[
    'wa_alertas_humano',
    'wa_blacklist',
    'wa_clientes_telefono',
    'wa_comprobantes',
    'wa_factura_consolidada',
    'wa_message_status',
    'wa_prospect_leads',
    'wa_rate_limit',
    'bot_reactivacion_config',
    'bot_reactivacion_log'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Sacarle el EXECUTE a `anon` sobre las funciones del bot
-- ─────────────────────────────────────────────────────────────────────────
-- Hay que revocar de PUBLIC (que es de donde `anon` hereda) y volver a
-- otorgar a service_role explícitamente: si el único grant era el de PUBLIC,
-- revocarlo también deja afuera a service_role.

do $$
declare f text;
begin
  foreach f in array array[
    'bot_encolar_recordatorios_25()',
    'bot_flush_outbox(integer)',
    'bot_outbox_mark(bigint, text, text)',
    'bot_pago_por_cliente_fecha(text, date)',
    'bot_reactivar_inactivos()',
    'bot_submit_order(text, jsonb, text)',
    'bot_tracking_produccion(text, integer)',
    'wa_check_rate_limit(text, integer)',
    'wa_comprobantes_touch_updated()',
    'wa_conversaciones_list()',
    'wa_expire_old_drafts()',
    'wa_faq_match(text)',
    'wa_find_question_group(text)',
    'wa_identify_customer(text)',
    'wa_is_human(text)',
    'wa_normalize_phone(text)',
    'wa_product_match(text, integer)',
    'wa_product_match_with_price(text, bigint, integer)'
  ]
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `product_aliases`: la policy que se llamaba service_role_all ahora lo es
-- ─────────────────────────────────────────────────────────────────────────
-- `anon_read` se deja como está (SELECT de los activos, es intencional).

alter policy "service_role_all" on public.product_aliases
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke insert, update, delete, truncate on public.product_aliases from anon, authenticated;
