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

Datos de pago (texto FIJO al final de las 6, no variable):
```
Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```

Notas para que Meta apruebe sin rechazo:
- El **nombre** va en minúsculas con guión bajo (los de abajo, exactos — coinciden con `app_settings`).
- En el formulario, el encabezado Documento pide un PDF de muestra: subí cualquiera.
- Meta pide **valores de ejemplo** para cada `{{n}}`: usá los que están abajo.
- Formato de importes: `$` + miles con punto, **sin decimales** (redondeado a pesos enteros, ej. `$153.355`). El bot ya lo arma así.

> ⚠️ **Reenvío a Meta**: crédito y e-cheq (single y múltiple) cambiaron de cuerpo y de cantidad de
> `{{n}}`. Al editar el cuerpo de una plantilla ya aprobada, Meta la vuelve a poner **en revisión**.
> El bot no envía con plantilla no aprobada (queda `held_tpl_no_aprobada`) y re-chequea el estado solo.
> Los **descuentos y plazos** ahora se editan desde el **Panel de Control → 💰 Descuentos por pago**
> (no están hardcodeados). `{{4}}`/fecha límite = fecha de factura + días de contado (14 por defecto).

---

## A) Una sola factura

### 1 · `pedido_contado_s`  (contado + clientes que no definieron)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Pagando al contado (25% de descuento) abonás: {{2}}

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$470.499` · `{{2}}`=`$352.874`

### 2 · `pedido_credito_s`  (plazos de crédito)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Con tu pago a {{2}} días abonás: {{3}}

*Pagando hasta el {{4}} podes ahorrarte {{5}}.*
*Total Contado: {{6}}*

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{2}}` = plazo elegido (editable en Panel): `15 a 30` / `31 a 45` / `46 a 60`.
`{{3}}` = monto con su plazo · `{{4}}` = fecha límite para pagar al contado (factura + 14 días) ·
`{{5}}` = ahorro (monto de su plazo − contado 25%) · `{{6}}` = total pagando al contado.
Ejemplos: `{{1}}`=`$743.418` · `{{2}}`=`31 a 45` · `{{3}}`=`$631.905` · `{{4}}`=`15/09/2026` · `{{5}}`=`$74.342` · `{{6}}`=`$557.564`

### 3 · `pedido_echeq_s`  (e-cheq)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Con tu pago por e-cheq a {{2}} días abonás: {{3}}
Recordá enviar el e-cheq al momento de recibir el pedido.

*Pagando hasta el {{4}} podes ahorrarte {{5}}.*
*Total Contado: {{6}}*

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{2}}` = plazo del e-cheq (editable en Panel): `90` / `120`. Resto igual que crédito
(`{{4}}` fecha límite contado, `{{5}}` ahorro, `{{6}}` total contado).
Ejemplos: `{{1}}`=`$1.587.098` · `{{2}}`=`90` · `{{3}}`=`$1.507.743` · `{{4}}`=`15/09/2026` · `{{5}}`=`$317.420` · `{{6}}`=`$1.190.324`

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

Pagando al contado (25% de descuento) abonás: {{4}}

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`$375.000`

### 5 · `pedido_credito_p`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

Con tu pago a {{4}} días abonás: {{5}}

*Pagando hasta el {{6}} podes ahorrarte {{7}}.*
*Total Contado: {{8}}*

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{4}}` = plazo elegido: `15 a 30` / `31 a 45` / `46 a 60` · `{{6}}` = fecha límite contado ·
`{{7}}` = ahorro vs. contado · `{{8}}` = total pagando al contado.
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`31 a 45` · `{{5}}`=`$425.000` · `{{6}}`=`15/09/2026` · `{{7}}`=`$50.000` · `{{8}}`=`$375.000`

### 6 · `pedido_echeq_p`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

Con tu pago por e-cheq a {{4}} días abonás: {{5}}
Recordá enviar el e-cheq al momento de recibir el pedido.

*Pagando hasta el {{6}} podes ahorrarte {{7}}.*
*Total Contado: {{8}}*

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{4}}` = plazo del e-cheq: `90` / `120` · `{{6}}` fecha límite contado · `{{7}}` ahorro · `{{8}}` total contado.
Ejemplos: `{{1}}`=`$500.000` · `{{2}}`=`3` · `{{3}}`=`$153.355 / $200.100 / $146.545` · `{{4}}`=`90` · `{{5}}`=`$475.000` · `{{6}}`=`15/09/2026` · `{{7}}`=`$100.000` · `{{8}}`=`$375.000`

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

Crédito y e-cheq muestran el bloque (cada línea en negrita, con su propio `*…*`):
"*Pagando hasta el {fecha} podes ahorrarte {ahorro}.*" y "*Total Contado: {contado}*", donde
`ahorro` = monto de su plazo − total al contado (25%), `fecha` = fecha de la factura + días de
contado. Contado/sin definir muestran el monto al contado.

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
