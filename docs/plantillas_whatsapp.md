# Plantillas WhatsApp — Tutorial de carga en Meta Business (WhatsApp Manager)

6 plantillas: 3 métodos de pago × (1 factura | varias facturas). El bot elige sola cuál
usar según el método del cliente y la cantidad de facturas del pedido.

## Campos comunes (para las 6)

| Campo | Valor |
|--|--|
| **Categoría** | Utilidad (Utility) |
| **Idioma** | Español (ARG) |
| **Encabezado** | Media → **Documento** (al enviar, el bot adjunta el PDF de la factura o el combinado) |
| **Pie de página** (opcional) | `Loekemeyer Mayorista` |
| **Botones** | ninguno |

Datos de pago al final de las 6. El rótulo "Datos para el pago:" va fijo; el **alias y el CBU son
variables** (los completa el bot desde la tabla del Panel):
```
Datos para el pago:
Alias: {{n}}
CBU: {{m}}
```
(en cada plantilla, `{{n}}`/`{{m}}` son los dos últimos `{{…}}` — ver el número exacto en cada una).

Notas para que Meta apruebe sin rechazo:
- El **nombre** va en minúsculas con guión bajo (los de abajo, exactos — coinciden con `app_settings`).
- En el formulario, el encabezado Documento pide un PDF de muestra: subí cualquiera.
- Meta pide **valores de ejemplo** para cada `{{n}}`: usá los que están abajo.
- Formato de importes: `$` + miles con punto, **sin decimales** (redondeado a pesos enteros, ej. `$153.355`). El bot ya lo arma así.

> ⚠️ **Reenvío a Meta**: las **6** cambiaron de cuerpo y de cantidad de `{{n}}`. Al editar el cuerpo de una
> plantilla ya aprobada, Meta la vuelve a poner **en revisión**. El bot no envía con plantilla no aprobada
> (queda `held_tpl_no_aprobada`) y re-chequea el estado solo (cada 30s).
> Los **descuentos y plazos** se editan en el **Panel de Control → 💰 Descuentos por pago** (no hardcodeados).
> El **% de descuento** y los **datos de pago (alias/CBU)** ahora son **variables** en cada plantilla (salen de
> la tabla del Panel), así que si cambiás un % o el alias/CBU, el mensaje se actualiza solo — sin re-editar Meta.
> La fecha límite de contado = fecha de factura + días de contado (14 por defecto, editable).
>
> 🔀 **Interruptor de formato** (`app_settings.wa_plantilla_formato`): `v1` = estructura vieja (sin %/alias/CBU
> variables, footer fijo, lo que está cargado hoy en Meta); `v2` = esta guía (nueva). El bot arma los `{{n}}`
> según ese flag. Mientras las plantillas de Meta tengan el formato viejo, dejar `v1`. Cuando termines de editar
> las 6 en Meta a este formato nuevo, poné `v2` — sin redeploy, impacta al toque. **NO** cambiar a `v2` antes de
> editar Meta (rompería el envío por cantidad de `{{n}}`).

---

## A) Una sola factura

### 1 · `pedido_contado_s`  (contado + clientes que no definieron)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

*Total a pagar Contado ({{2}}% Dto): {{3}}*

Datos para el pago:
Alias: {{4}}
CBU: {{5}}
```
`{{2}}` = % de descuento contado (de la tabla, ej. `25`) · `{{3}}` = monto a pagar al contado ·
`{{4}}` = alias · `{{5}}` = CBU (datos de pago, editables en el Panel).
Ejemplos: `{{1}}`=`$470.499` · `{{2}}`=`25` · `{{3}}`=`$352.874` · `{{4}}`=`loeke.srl` · `{{5}}`=`1910027855002702387450`

### 2 · `pedido_credito_s`  (plazos de crédito)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

*Con tu pago a {{2}} días abonás: {{3}} ({{4}}% Dto)*

*Pagando hasta el {{5}} podés ahorrarte {{6}}.*
*Total Contado: {{7}}*

Datos para el pago:
Alias: {{8}}
CBU: {{9}}
```
`{{2}}` = plazo (de la tabla): `15 a 30` / `31 a 45` / `46 a 60` · `{{3}}` = monto con su plazo ·
`{{4}}` = % de descuento del plazo (de la tabla, ej. `20`) · `{{5}}` = fecha límite contado (factura + 14 días) ·
`{{6}}` = ahorro (monto de su plazo − contado) · `{{7}}` = total pagando al contado · `{{8}}` = alias · `{{9}}` = CBU.
Ejemplos: `{{1}}`=`$743.418` · `{{2}}`=`31 a 45` · `{{3}}`=`$631.905` · `{{4}}`=`15` · `{{5}}`=`15/09/2026` · `{{6}}`=`$74.342` · `{{7}}`=`$557.564` · `{{8}}`=`loeke.srl` · `{{9}}`=`1910027855002702387450`

### 3 · `pedido_echeq_s`  (e-cheq)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

*Con tu pago por e-cheq a {{2}} días abonás: {{3}} ({{4}}% Dto)*
Recordá enviar el e-cheq al momento de recibir el pedido.

*Pagando hasta el {{5}} podés ahorrarte {{6}}.*
*Total Contado: {{7}}*

Datos para el pago:
Alias: {{8}}
CBU: {{9}}
```
`{{2}}` = plazo del e-cheq (de la tabla): `90` / `120` · `{{4}}` = % de descuento (ej. `5`). Resto igual que
crédito (`{{5}}` fecha límite contado, `{{6}}` ahorro, `{{7}}` total contado, `{{8}}` alias, `{{9}}` CBU).
Ejemplos: `{{1}}`=`$1.587.098` · `{{2}}`=`90` · `{{3}}`=`$1.507.743` · `{{4}}`=`5` · `{{5}}`=`15/09/2026` · `{{6}}`=`$317.420` · `{{7}}`=`$1.190.324` · `{{8}}`=`loeke.srl` · `{{9}}`=`1910027855002702387450`

---

## B) Varias facturas (pedido dividido)

`{{2}}` = cantidad de facturas · `{{3}}` = importes individuales separados por ` / `
(ej. `$153.355 / $200.100 / $99.999`). Los `{{n}}` de método/descuento corren dos lugares
respecto del single (por los campos `{{2}}` cantidad y `{{3}}` detalle).

### 4 · `pedido_contado_p`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

*Total a pagar Contado ({{4}}% Dto): {{5}}*

Datos para el pago:
Alias: {{6}}
CBU: {{7}}
```
`{{4}}` = % de descuento contado (ej. `25`) · `{{5}}` = monto a pagar al contado · `{{6}}` = alias · `{{7}}` = CBU.
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`25` · `{{5}}`=`$375.000` · `{{6}}`=`loeke.srl` · `{{7}}`=`1910027855002702387450`

### 5 · `pedido_credito_p`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

*Con tu pago a {{4}} días abonás: {{5}} ({{6}}% Dto)*

*Pagando hasta el {{7}} podés ahorrarte {{8}}.*
*Total Contado: {{9}}*

Datos para el pago:
Alias: {{10}}
CBU: {{11}}
```
`{{4}}` = plazo (de la tabla): `15 a 30` / `31 a 45` / `46 a 60` · `{{6}}` = % de descuento del plazo ·
`{{7}}` = fecha límite contado · `{{8}}` = ahorro vs. contado · `{{9}}` = total contado · `{{10}}` = alias · `{{11}}` = CBU.
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`31 a 45` · `{{5}}`=`$425.000` · `{{6}}`=`15` · `{{7}}`=`15/09/2026` · `{{8}}`=`$50.000` · `{{9}}`=`$375.000` · `{{10}}`=`loeke.srl` · `{{11}}`=`1910027855002702387450`

### 6 · `pedido_echeq_p`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

*Con tu pago por e-cheq a {{4}} días abonás: {{5}} ({{6}}% Dto)*
Recordá enviar el e-cheq al momento de recibir el pedido.

*Pagando hasta el {{7}} podés ahorrarte {{8}}.*
*Total Contado: {{9}}*

Datos para el pago:
Alias: {{10}}
CBU: {{11}}
```
`{{4}}` = plazo del e-cheq: `90` / `120` · `{{6}}` = % de descuento (ej. `5`) · `{{7}}` fecha límite contado ·
`{{8}}` ahorro · `{{9}}` total contado · `{{10}}` alias · `{{11}}` CBU.
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`90` · `{{5}}`=`$475.000` · `{{6}}`=`5` · `{{7}}`=`15/09/2026` · `{{8}}`=`$100.000` · `{{9}}`=`$375.000` · `{{10}}`=`loeke.srl` · `{{11}}`=`1910027855002702387450`

---

## Cómo el bot elige y llena (referencia técnica)

`supabase/functions/lk_factura-check` (`armarMensaje`) decide:
- **Grupo por método** (`wa_metodo_norm` sobre `condicion_venta` de la factura):
  contado / no_decidido → contado · credito_* → credito · echeq_* → echeq.
- **Single vs múltiple**: según cantidad de facturas del pedido.
- **Descuentos y plazos**: se leen de `app_settings.wa_descuentos_config` (editable en el
  **Panel de Control → 💰 Descuentos por pago**). Defaults: contado 25% (vence a 14 días),
  15-30d 20%, 31-45d 15%, 46-60d 10%, e-cheq 90d 5%, e-cheq 120d 0%. `no_decidido` → contado.
  Las claves de las bandas (`credito_15_30`, `echeq_90`, …) coinciden con `wa_metodo_norm`.
- **Importes redondeados sin decimales** (`fmtARS`).
- **% de descuento como variable**: cada plantilla recibe el % (contado o del plazo) desde la tabla; el
  literal `%` va fijo en el cuerpo de Meta y el número lo completa el bot (ej. `({{n}}% Dto)`).

Todas las líneas de método y el bloque de ahorro van **en negrita** (cada una con su propio `*…*`):
"*Con tu pago a {plazo} días abonás: {monto} ({dto}% Dto)*", "*Pagando hasta el {fecha} podés ahorrarte
{ahorro}.*", "*Total Contado: {contado}*". `ahorro` = monto de su plazo − total al contado; `fecha` = fecha
de la factura + días de contado. Contado muestra "*Total a pagar Contado ({dto}% Dto): {monto}*".

Nombres configurables en `app_settings` (PaginaLK): `wa_tpl_contado`, `wa_tpl_credito`,
`wa_tpl_echeq`, `wa_tpl_contado_multiple`, `wa_tpl_credito_multiple`, `wa_tpl_echeq_multiple`.

**Chequeo de método mixto**: si en un grupo de facturas no todas tienen el mismo método,
el bot marca `metodo_mixto: true` y pone `estado='held_metodo_mixto'` (no procede al envío
hasta revisión). Las 6 usan el separador ` / ` para la lista de importes `{{3}}`.

**Gatillo (dormant)**: `sql/gp_trigger_grupo_listo.sql` (GP) crea el trigger
`wa_np_facturado_trg` sobre `Facturacion_NP` que, al facturarse la última NP de un grupo
(cliente+destino+día, según `wa_np_snapshot`), encola el grupo en `wa_grupo_listo`. Se crea
**DESACTIVADO**; encender con `alter table "Facturacion_NP" enable trigger wa_np_facturado_trg;`
cuando se prenda el bot. No envía: solo detecta y encola.

## Límite de caracteres (confirmado con docs de Meta / BSPs)
- **Cuerpo (body): 1024 caracteres.** Los `{{n}}` cuentan como 1 char en la definición, pero
  **al enviar, el cuerpo ya con los valores sustituidos tampoco puede pasar de 1024**.
- **Encabezado (texto): 60** · **Pie de página: 60** · **Botón: 25** (no usamos texto en header/footer variable).

Peor caso = crédito múltiple: texto fijo ~200 + valores ~50 + lista `{{3}}` ≈ 14 chars por
factura. Para no pasar 1024: `14 × N ≤ ~770` → caben **~55 facturas** en un mismo pedido.
Un pedido real se parte en 2-6, así que no hay riesgo práctico. Si algún día un pedido tuviera
decenas de facturas, acortar el formato de la lista `{{3}}`.

## Estado
El bot selecciona y completa las 6 plantillas con la lógica nueva (descuentos editables, importes
redondeados, bloque de ahorro con fecha límite). Crédito y e-cheq (single/múltiple) deben **re-editarse
en Meta** con el cuerpo de arriba y esperar re-aprobación; el bot no envía con plantilla no aprobada.
Restricción activa: los envíos reales salen **sólo a la lista blanca** (`wa_envio_contactos`).
