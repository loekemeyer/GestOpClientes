# Promo cross-sell LK — recomendador de qué ofrecer a cada cliente

Última actualización: 2026-10-15 · Pedido de Pablo Olejavetzky · Tarea Planify 5692 (cerrada "por ahora").

Estado: **análisis listo y vivo, nada enviado.** Falta definir las reglas de negocio de qué ofrecer
y toda la capa de envío (plantilla Meta, opt-in, apertura de la llave). Vive detrás de la llave
`wa_envio_automatico`: el bot no contacta a nadie hasta que Luis/Thomas abran la lista blanca (principio
VASECTOMÍA, ver `CLAUDE.md`).

## Objetivo

Promo de marketing por WhatsApp a clientes **que ya compran**: detectar qué categorías/productos
**no consumen** y ofrecérselos para generar ventas nuevas (cross-sell). Primera etapa: **solo Loekemeyer**.
Chef queda para una etapa 2.

## De dónde salen los datos

- **Historial de compras = facturación real, no la web.** Vive en ISIS (proyecto Supabase
  `hrxfctzncixxqmpfhskv`), schema `isis_lk`: `documentos` (cabecera) + `documento_items` (renglón),
  parseadas de los PDF de factura. `isis_ch` es el equivalente de Chef.
- **Filtro de ventas:** `documentos.familia = 'factura_venta'`. `nc_venta` son notas de crédito
  (devoluciones, restar si se quiere neto), `compra`/`nc_compra` son compras a proveedores (excluir,
  si no se recomiendan productos de proveedor). El resto (`stock`, `tesoreria`, etc.) no es venta.
- **Volumen (medido 2026-10-13):** total histórico 32.986 facturas, 252.623 renglones, 1.783 clientes,
  864 artículos, desde 2019. **Recorte de 12 meses** (la ventana que se usa): 3.569 facturas de venta,
  599 clientes, 226 artículos, 42.852 renglones.
- **Categoría de cada artículo:** vive en PaginaLK (`kwkclwhmoygunqmlegrg`), `public.products`
  (`cod`, `category`, `subcategory`, `active`). Son ~201 activos en ~24 categorías.
- **Cruce factura ↔ categoría:** `documento_items.codigo_articulo = products.cod`, **exacto**
  (la "E" final, ej. `584E`, es parte del código, no un sufijo a limpiar). Matchean 202 de 226
  artículos vendidos en 12m (89%); el 11% restante son códigos de ERP que nunca entraron al catálogo
  web y quedan "sin categoría".

## El problema del cruce entre proyectos

La categoría está en PaginaLK y las facturas en ISIS: **son dos proyectos Supabase distintos**, una
vista no cruza los dos. PaginaLK tiene un FDW `virgilio_db` que apunta a ISIS, así que se puede leer
ISIS desde PaginaLK. **El FDW es lento para transferir filas** (un `COUNT(*)` se empuja al remoto y
vuelve al instante, pero traer 42.930 filas se pasa de los 60 s del MCP). Por eso la foto de ventas se
cargó **por tandas mensuales** en una tabla local, y el refresco debe correr server-side (cron), no por
MCP.

## Qué quedó armado (PaginaLK, schema `promo`, todo con RLS)

- `promo.isis_documentos`, `promo.isis_documento_items` — foreign tables vía `virgilio_db` a `isis_lk`.
- `promo.mv_ventas_12m` — **vista materializada** con la foto de ventas de los últimos 12 meses
  (factura_venta), con la categoría de `products` y la razón social ya limpia. La refresca el cron.
- `promo.v_promo_gap_12m` — **la vista del recomendador** (lee de la matview).

El SQL completo y reproducible está en `sql/145_promo_cross_sell_lk.sql`.

## Lógica del recomendador (por categoría)

1. Por cada cliente, qué categorías compró en 12 meses.
2. Penetración de cada categoría entre todos los clientes (`pct_pares`).
3. **Hueco** = categoría que muchos pares compran y este cliente no.
4. **Candidato** = el producto activo más vendido de esa categoría (popularidad entre pares). Como el
   cliente no compró nada de esa categoría, el candidato es el mismo para todos los que tienen ese hueco.
5. Se rankea por `pct_pares` (`rank_cliente`). El nombre sale como **razón social limpia** (sin saltos
   de línea, espacios colapsados, trim).

**Limitación conocida:** esta primera versión es un "hueco de popularidad" — a muchos les toca el mismo
producto (lo que casi todos compran y ellos no). Sirve y es de bajo riesgo, pero no personaliza. La
etapa 2 agrega afinidad por artículo (lift) para que a cada uno le llegue algo más propio.

## Chef (etapa 2)

Unir por **CUIT** (`documentos.contraparte_cuit`), que cruza LK e ISIS/Chef en el mismo proyecto.
Solape medido: 35 CUIT compran en ambos, 78 compran solo Chef, 604 LK. **Bloqueo:** Chef no tiene
catálogo con categoría accesible (vive en el proyecto Chef, sin MCP) y sólo el 21,9% de su volumen
mapea a categorías LK por el sufijo "L" de sus códigos. Hasta no tener el catálogo de Chef con
categoría, no entra bien al recomendador por categoría.

## Nombre de fantasía

**No existe un campo confiable.** La factura trae razón social; `customers.business_name` la repite
(difiere en 32 de 599 y esos son ruido: saltos de línea, truncados, typos). ISIS no tiene campo de
fantasía. Por eso la promo arranca con **razón social limpia**. Capturar el nombre comercial (lo cargan
los vendedores o se trae de donde el ERP lo tenga) es una tarea aparte.

## Ejemplo para el equipo

Artifact (privado, compartir desde su menú Compartir para que lo abran Luis/Thommy):
https://claude.ai/artifact/MwWujycG7qPJAHf7R7Qs5R — 12 clientes reales con su hueco, producto sugerido y
el mensaje borrador. El texto es borrador, no la plantilla final de Meta.

## Pendientes

1. **Definir las reglas de qué ofrecer** (categoría vs afinidad, margen, estacionalidad, excluir lo
   devuelto, topes). Con eso se ajusta el ranking.
2. ~~Función de refresco~~ — resuelto sin función. El refresco es una **vista materializada**
   (`promo.mv_ventas_12m`) que refresca el **cron `promo_refresh_ventas_12m`** (diario 08:20 UTC /
   ~05:20 AR, `refresh materialized view`). Todo armado por MCP. Se descartó la función plpgsql porque el
   MCP no la puede crear (`;` en el literal `$$…$$`). El refresh hace un pull completo por FDW (~43k
   filas) server-side, sin el límite de 60 s del MCP.
3. **Plantilla MARKETING de Meta** (una promo es marketing, no utility: ~US$ 0,0618/mensaje, aprobación
   1-3 días).
4. **Opt-in** por cliente (no hay campo hoy).
5. **Encolar en `wa_outbox`** (template, no texto libre, por ser fuera de ventana de 24 h) y abrir la
   llave `wa_envio_automatico` cuando Luis dé el OK.
6. **Chef etapa 2** y **nombre de fantasía** (arriba).

Costo estimado de un piloto de 100 clientes: ~US$ 6,3 de Meta (plantilla MARKETING); la IA del copy es
despreciable.
