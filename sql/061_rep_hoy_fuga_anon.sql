-- 061 — 🔴 La plata de la empresa se leía con la anon key (pública)
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-09-09 · APLICADO
--
-- ── Qué se encontró ────────────────────────────────────────────────────────────────────────
-- Buscando cómo mandar el reporte de gerencia por WhatsApp (idea 6600) apareció esto:
--
--   rep_texto_hoy(date)  → SECURITY DEFINER, EXECUTE para PUBLIC / anon / authenticated
--   rep_enviar_hoy()     → SECURITY DEFINER, EXECUTE para PUBLIC / anon / authenticated
--
-- La anon key de LK es **pública por diseño** (va embebida en la página y en `admin/admin.js`),
-- así que cualquiera que la copie del navegador podía hacer:
--
--   POST /rest/v1/rpc/rep_texto_hoy   {"p_fecha":"2026-09-08"}
--
-- y recibir la facturación del día y la del mes a la fecha. **No es teoría, se midió** — con
-- `set local role anon` la función devolvió, palabra por palabra:
--
--   💰 HOY · lunes 07/09
--   🛒 PEDIDOS DE CLIENTES (portal)
--     $4.6 M  ·  5 ped  ·  5 cli
--      ▼78% vs promedio de los últimos 4 lunes
--     Mes a la fecha: $58.6 M
--
-- `SECURITY DEFINER` es lo que lo hacía posible: la función corre como su dueño, así que la RLS
-- de las tablas de ventas no la frena. Es el mismo mecanismo que el 2026-09-04 costó una fuga
-- real por una vista sin `security_invoker`.
--
-- Y `rep_enviar_hoy()` era peor en otro sentido: cualquiera podía dispararlo y meter mensajes
-- en la cola de Telegram de gerencia (o quemar el `dedup_key` del día para que el reporte de
-- verdad no saliera).
--
-- ── Por qué era un descuido y no una decisión ──────────────────────────────────────────────
-- `rep_salud()`, de la misma familia y del mismo día, está bien: `postgres` + `service_role` y
-- nada más. De las funciones `rep_*`, sólo estas dos tenían el grant abierto; las otras dos que
-- aparecen en el barrido (`rep_plata`, `rep_var`) son formateadores puros —"$4.6 M", "▼78%"—,
-- no tocan datos y no son SECURITY DEFINER, así que no filtran nada.
--
-- ── Verificado antes de tocar ──────────────────────────────────────────────────────────────
-- Ningún front las llama: `grep -rn "rep_texto_hoy\|rep_enviar_hoy" ` sobre `pagina-lk-copia`,
-- `paginach`, `Gestion-Virgilio` y `gestopclientes` (js/html/ts) → **cero** resultados. El único
-- consumidor es el cron 36 `reporte-hoy-plata-telegram`, que corre como `postgres` y no se ve
-- afectado por un revoke a `anon`.

revoke execute on function public.rep_texto_hoy(date) from public, anon, authenticated;
revoke execute on function public.rep_enviar_hoy()    from public, anon, authenticated;
grant  execute on function public.rep_texto_hoy(date) to service_role;
grant  execute on function public.rep_enviar_hoy()    to service_role;

-- ── Comprobación, en las dos direcciones ───────────────────────────────────────────────────
-- Antes:  anon → devolvía el reporte completo.
-- Ahora:  begin; set local role anon;        select public.rep_texto_hoy(current_date - 1); rollback;
--           → ERROR 42501: permission denied for function rep_texto_hoy   ✅
--         begin; set local role service_role; select public.rep_texto_hoy(current_date - 1); rollback;
--           → "💰 HOY · martes 08/09 …"                                    ✅ (el cron sigue andando)
--
-- ROLLBACK (no hacerlo salvo que se pruebe que algo lo llamaba como anon):
--   grant execute on function public.rep_texto_hoy(date) to anon, authenticated;
--   grant execute on function public.rep_enviar_hoy()    to anon, authenticated;
--
-- ── ⚠ PENDIENTE, más grande que esto ───────────────────────────────────────────────────────
-- En `public` hay **47 funciones SECURITY DEFINER ejecutables por anon**. Muchas tienen que
-- serlo (login, catálogo, alta de pedido) y varias chequean permisos adentro — por ejemplo
-- `get_customer_history` valida `auth.uid()` contra `customers`/`admins` antes de devolver nada.
-- Pero nadie las revisó una por una. Estas dos aparecieron de casualidad. Hace falta pasar la
-- lista completa y separar "expuesta a propósito y con chequeo adentro" de "expuesta de más".

-- ── Anexo (mismo día) — `app_settings` publicaba la lista de gerencia ──────────────────────
-- Al cargar `wa_gerencia_phones` (la lista de quién puede pedir el reporte por WhatsApp,
-- idea 6600) se comprobó que `anon` la leía: la policy `app_settings_select_all` es una
-- LISTA NEGRA por nombre de clave —`token|secret|service_key|service_role|api_key|apikey|
-- password|passwd|clave`— y "gerencia" no cae en ninguno.
--
-- Medido con `set local role anon`: devolvía `["5491162521635"]`.
--
-- No da acceso a nada por sí solo —el bot valida el `from` que manda Meta, que un cliente web
-- no puede falsificar— pero es una lista de autorizados: publicarla es decirle a cualquiera
-- exactamente qué número conviene suplantar o al que conviene ir por ingeniería social.
--
-- Se agregan `gerencia` y `whitelist` al patrón. Verificado que ningún front lee esas claves
-- (grep sobre `admin.js`, `script.js`, `admin-supercot.js`: cero hits); las leen las Edge
-- Functions con `service_role`, que saltea la RLS.

drop policy app_settings_select_all on public.app_settings;

create policy app_settings_select_all on public.app_settings
  for select to anon, authenticated
  using (key !~* '(token|secret|service_key|service_role|api_key|apikey|password|passwd|clave|gerencia|whitelist)');

-- Comprobado como anon: wa_gerencia_phones → 0 filas; wa_descuentos_config → sigue visible
-- (el front la necesita para mostrarle al cliente el CBU y el alias); 21 claves visibles.
--
-- ⚠ La lista negra es frágil por diseño: cada clave sensible nueva hay que acordarse de que
-- matchee el patrón, y si no, se publica sola. Lo correcto sería una lista BLANCA de las
-- claves que el front necesita. No se hace ahora porque hay que relevar qué lee cada front y
-- una equivocación deja la página sin datos; queda anotado.
