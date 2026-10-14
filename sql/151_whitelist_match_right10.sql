-- 151 — El gate de whitelist tiene que matchear por los últimos 10 dígitos, no por el string completo
-- Proyecto PaginaLK (kwkclwhmoygunqmlegrg) · 2026-10-14 · Pablo Olejavetzky
-- APLICADO en vivo en esta sesión (execute_sql). Este archivo queda como registro.
-- Auditoría: github_repo_problemas id 771.
--
-- Problema (medido el 14/10, pedido de prueba a Garbarino 4210):
--   El número de prueba se cargó en wa_envio_contactos como 541131181027 (sin el 9 argentino).
--   El template SALIÓ bien (Meta entrega igual), pero cuando el teléfono le contestó al bot, el
--   inbound de Meta llega con el 9 (5491131181027) y el gate lo descartó en silencio: dejó la
--   alerta wa_alertas_humano 871 (tipo whitelist_gate) y el bot nunca respondió.
--
-- Causa: dos chequeos comparaban los dígitos COMPLETOS, no los últimos 10 como sí hace
--   wa_identify_customer. canonPhone (TS) no unifica el 9, así que el mismo teléfono tiene dos
--   representaciones (con y sin 9) y el match exacto fallaba.
--     1) wa_puede_enviar (salida)  → esta migración.
--     2) estaEnWhitelist (entrada, lk_whatsapp-webhook/index.ts) → en el mismo commit, se deploya por CI.
--
-- Fix: comparar right(digits, 10) en ambos lados. Un teléfono de < 10 dígitos no matchea (length = 10).
--   No afecta la llave ('1' manda a todos, '0'/nada no manda) ni abre la salida a números fuera de
--   wa_envio_contactos: sigue siendo la misma lista, sólo que tolerante al formato del 9.
--
-- Rollback: la definición anterior (match por dígitos completos) está en sql/070_wa_canal_prueba_unico.sql.

create or replace function public.wa_puede_enviar(p_phone text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select case coalesce((select s.value from app_settings s where s.key = 'wa_envio_automatico'), '0')
           when '1' then true
           when 'prueba' then (
             length(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)) = 10
             and exists (
               select 1 from wa_envio_contactos c
                where right(regexp_replace(c.phone, '\D', '', 'g'), 10)
                    = right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)))
           else false
         end;
$function$;
revoke all on function public.wa_puede_enviar(text) from public, anon, authenticated;
grant execute on function public.wa_puede_enviar(text) to service_role;

-- Verificación (14/10, con wa_envio_automatico='prueba' y 5491131181027 en la whitelist):
--   select public.wa_puede_enviar('5491131181027');    -- true (con 9)
--   select public.wa_puede_enviar('541131181027');     -- true (sin 9)
--   select public.wa_puede_enviar('5491199999999');    -- false (fuera de whitelist)
--   select public.wa_puede_enviar('123');              -- false (corto)
