-- 130_bot_fotos_producto_url_real.sql — la foto que manda el bot apunta a un archivo que EXISTE y que Meta acepta.
--
-- Pablo Olejavetzky, 08/10/2026: "me reportan problemas con el envío de las imágenes solicitadas".
-- Caso real: Damián (Chef 411) pidió la foto del 505 a las 09:39 y el bot la "mandó" 5 veces. Las 5 volvieron como
-- `failed` en wa_message_status: 131053 "Downloading media from weblink failed with http code 400".
--
-- Causa: sin nada en products.images, la versión anterior armaba `products-images/<cod>.jpg`, y ese archivo no existe
-- para NINGÚN artículo activo (0 de 197). En el bucket hay `<cod>.webp` (subidos con contenido JPEG casi todos) y
-- `hd/<cod>.jpg`. El Storage contesta 400 a un objeto inexistente, Meta lo rechaza DESPUÉS de aceptar el envío (asincrónico),
-- y el bot le dice al cliente "te la mandé" sin que le llegue nada. Los 3 con products.images cargado (514E, 590ES, 516)
-- tenían el NOMBRE del objeto ("514E.webp"), no una URL: tampoco salían. Total: 200 de 200 activos sin foto posible.
--
-- Ahora elige, en este orden, el primer objeto que exista con contenido JPEG o PNG y menos de 5 MB (límite de Meta):
--   1) hd/<cod>.jpg (JPEG de 0,7 MB en promedio, 1,3 MB el mayor)   → 175 activos al 08/10
--   2) lo que diga products.images (nombre del objeto o URL del bucket) → 590ES usa 590E.webp
--   3) <cod>.webp si su contenido es JPEG o PNG                       → 23 activos (175 + 23 = 198 de 200)
-- WebP de verdad (image/webp) no sirve: Meta sólo acepta JPEG y PNG en mensajes de imagen (WebP es para stickers).
-- Quedan sin foto 067 y 537 (sólo tienen WebP real): devuelve image_urls vacío y el bot contesta que no tiene foto,
-- en vez de prometerla.
--
-- Misma firma y mismos permisos: el código (enviar_fotos_producto en _shared/bot-conversation.ts) no cambia.

create or replace function public.bot_obtener_imagenes_producto(p_cod text)
returns table(cod text, description text, image_urls text[])
language sql
stable
security definer
set search_path to 'public'
as $function$
  with p as (
    select p.cod, p.description, p.images
      from public.products p
     where p.active = true
       and p.cod = p_cod
       and length(p_cod) between 1 and 30
     limit 1
  ),
  cand as (
    select 1 as prio, 0::bigint as ord, 'hd/' || p.cod || '.jpg' as obj from p
    union all
    select 2, i.ord, regexp_replace(i.img, '^https?://[^/]+/storage/v1/object/public/products-images/', '')
      from p, unnest(p.images) with ordinality as i(img, ord)
    union all
    select 3, 0, p.cod || '.webp' from p
  ),
  apta as (
    select c.obj
      from cand c
      join storage.objects o on o.bucket_id = 'products-images' and o.name = c.obj
     where o.metadata->>'mimetype' in ('image/jpeg', 'image/png')
       and coalesce((o.metadata->>'size')::bigint, 0) between 1 and 5242880
     order by c.prio, c.ord
     limit 1
  )
  select p.cod,
         p.description,
         coalesce(
           (select array['https://kwkclwhmoygunqmlegrg.supabase.co/storage/v1/object/public/products-images/' || a.obj] from apta a),
           '{}'::text[]
         ) as image_urls
    from p
$function$;
