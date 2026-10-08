-- 132_bot_fotos_producto_rgb.sql — la foto que manda el bot es la web (JPEG RGB de 1000 px), no la HD (CMYK).
--
-- Corrige el orden de sql/130 el mismo día (08/10/2026, Pablo Olejavetzky). sql/130 ponía primero hd/<cod>.jpg, pero al
-- preparar el reenvío a Damián se midió el canal de color de cada archivo (marcador SOF del JPEG, leído con un Range):
--   · hd/<cod>.jpg   → 132 de 175 en CMYK (4 canales). Meta pide imágenes RGB o RGBA de 8 bits: en CMYK lo más probable
--                      es que la rechace igual (131053), o que salga con los colores cambiados.
--   · <cod>.webp     → 190 de 190 JPEG en RGB (1000 × 1000, unos 53 KB), más 508.webp que es PNG. El nombre dice .webp
--                      pero el Storage lo sirve como image/jpeg (o image/png): eso es lo que mira Meta.
-- Orden nuevo: 1) products.images  2) <cod>.webp con contenido JPEG o PNG  3) hd/<cod>.jpg (último recurso).
-- Resultado sobre 200 activos: 192 con la foto web, 6 con la HD (231, 232, 233, 567 y 580 en RGB, 599E en CMYK: puede
-- fallar), 2 sin foto (067 y 537, sólo WebP real). El canal de color no está en la metadata del Storage: si se suben
-- fotos nuevas, que sean JPEG RGB o PNG.

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
    select 1 as prio, i.ord, regexp_replace(i.img, '^https?://[^/]+/storage/v1/object/public/products-images/', '') as obj
      from p, unnest(p.images) with ordinality as i(img, ord)
    union all
    select 2, 0::bigint, p.cod || '.webp' from p
    union all
    select 3, 0::bigint, 'hd/' || p.cod || '.jpg' from p
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
