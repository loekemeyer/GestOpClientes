-- PaginaLK (kwkclwhmoygunqmlegrg) — Bandeja: una conversación resuelta se reabre sola cuando el cliente vuelve a escribir.
--
-- Pedido de Pablo Olejavetzky, 08/10/2026: "cuando un cliente vuelve a escribir tiene que volver a aparecer arriba el
-- mensaje, sigue como resuelta".
--
-- Antes: wa_human_control.estado = 'resuelto' quedaba para siempre. Sólo lo cambiaban 'tomar' y 'set_estado' desde el
-- panel, así que lk_conversaciones (action list) la seguía dando como "resuelta" y la bandeja (docs/gestop2.js) la
-- mandaba al fondo (RANGO resuelta = 3), aunque el cliente hubiera escrito de nuevo.
-- Caso real: Chef 411 (5491131181594), resuelta el 08/10 a las 12:45:57 UTC, escribió 21 s después y siguió resuelta.
--
-- Por qué un trigger y no un cálculo en el listado: el momento en que se resolvió no está guardado (updated_at lo pisa
-- también mark_read, que corre cada vez que alguien abre la charla), y todo mensaje entrante pasa por bot_historial_chat
-- (bot_guardar_mensaje con rol 'user': webhook y seed_demo). Los mensajes del bot o de un humano (rol 'assistant') no
-- reabren: un aviso automático a una charla resuelta no la saca de resuelta.
-- Al reabrir queda 'abierto' = estado "Bot" en la bandeja (o "Esperando humano" si el bot vuelve a derivar).

create or replace function public.wa_reabrir_resuelta() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.wa_human_control
     set estado = 'abierto', updated_at = now()
   where phone = new.telefono and estado = 'resuelto';
  return null;
end;
$$;

create or replace trigger trg_wa_reabrir_resuelta
  after insert on public.bot_historial_chat
  for each row when (new.rol = 'user')
  execute function public.wa_reabrir_resuelta();

-- Las que ya quedaron mal: resueltas con un mensaje del cliente posterior a su updated_at. updated_at es el mejor dato
-- que hay del momento de resolver; si alguien abrió la charla después del mensaje (mark_read lo pisa), esa no se ve acá.
update public.wa_human_control hc
   set estado = 'abierto', updated_at = now()
 where hc.estado = 'resuelto'
   and exists (select 1 from public.bot_historial_chat h
                where h.telefono = hc.phone and h.rol = 'user' and h.creado_en > hc.updated_at);
