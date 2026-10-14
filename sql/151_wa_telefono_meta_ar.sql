-- 151_wa_telefono_meta_ar.sql — Normalización del teléfono a formato Meta (549) en el origen.
--
-- Proyecto: PaginaLK (kwkclwhmoygunqmlegrg).
--
-- Problema (auditoría github_repo_problemas id 779): los avisos de pedido
-- (pedido_recibido, pedido_programado_*) salían al número SIN el 9 de celular argentino
-- cuando el número se cargaba mal en bot_customer_whatsapps, y no llegaban. Ningún punto
-- forzaba el formato Meta: los triggers de aviso leen bcw.whatsapp directo, lk_outbox-flush
-- manda `to: m.phone` tal cual, y wa-guard sólo bloquea/pasa (no reescribe el destino).
-- normalize_phone, además, quita el 9 a propósito (es el canónico interno, sin 549).
--
-- Solución: un candado en el ORIGEN. Como todos los avisos salientes leen bcw.whatsapp,
-- se fuerza el formato Meta (549 + área + número) al insertar o actualizar esa columna.

-- Devuelve el teléfono en formato Meta para móvil argentino: 549 + área + número.
-- Idempotente: '541131181027', '5491131181027', '1131181027', '+54 9 11 3118-1027' y
-- '01131181027' devuelven todos '5491131181027'. NULL si no quedan dígitos suficientes.
create or replace function public.wa_phone_meta_ar(raw text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if raw is null then return null; end if;
  d := regexp_replace(raw, '\D', '', 'g');
  if d = '' then return null; end if;
  if left(d, 2) = '54' then d := substring(d from 3); end if;  -- saca el país
  if left(d, 1) = '0'  then d := substring(d from 2); end if;  -- saca el 0 de larga distancia
  if left(d, 1) = '9'  then d := substring(d from 2); end if;  -- saca el 9 (se re-agrega canónico)
  if length(d) < 8 then return null; end if;
  return '549' || d;                                           -- formato Meta móvil AR
end $$;

-- Trigger BEFORE: normaliza bot_customer_whatsapps.whatsapp a formato Meta al guardarlo.
create or replace function public.wa_bcw_normalize_trg() returns trigger language plpgsql as $$
begin
  new.whatsapp := public.wa_phone_meta_ar(new.whatsapp);
  return new;
end $$;

drop trigger if exists wa_bcw_normalize_meta on public.bot_customer_whatsapps;
create trigger wa_bcw_normalize_meta
  before insert or update of whatsapp on public.bot_customer_whatsapps
  for each row execute function public.wa_bcw_normalize_trg();
