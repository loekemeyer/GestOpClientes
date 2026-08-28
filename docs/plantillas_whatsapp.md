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
- Formato de importes: `$` + miles con punto + coma decimal + 2 decimales (ej. `$153.355,46`). El bot ya lo arma así.

---

## A) Una sola factura

### 1 · `pedido_contado`  (contado + clientes que no definieron)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Pagando al contado (25% de descuento) abonás: {{2}}

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$470.498,88` · `{{2}}`=`$352.874,16`

### 2 · `pedido_credito`  (plazos de crédito)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Con tu pago a {{2}} días abonás: {{3}}

Pagando al contado ahorrarías {{4}}.

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{2}}` = plazo elegido: `15 a 30` / `31 a 45` / `46 a 60`.
Ejemplos: `{{1}}`=`$743.418,34` · `{{2}}`=`31 a 45` · `{{3}}`=`$631.905,59` · `{{4}}`=`$74.341,83`

### 3 · `pedido_echeq`  (e-cheq)
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tu factura (con IVA): {{1}}

Con tu pago por e-cheq abonás: {{2}}
Recordá enviar el e-cheq de manera anticipada.

Pagando al contado ahorrarías {{3}}.

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$1.587.098,44` · `{{2}}`=`$1.507.743,52` · `{{3}}`=`$317.419,69`

---

## B) Varias facturas (pedido dividido)

`{{2}}` = cantidad de facturas · `{{3}}` = importes individuales separados por espacio
(ej. `$153.355,46 $200.100,00 $99.999,99`). Los descuentos corren un lugar.

### 4 · `pedido_contado_multiple`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

Pagando al contado (25% de descuento) abonás: {{4}}

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$500.000,00` · `{{2}}`=`3` · `{{3}}`=`$153.355,46 $200.100,00 $146.544,54` · `{{4}}`=`$375.000,00`

### 5 · `pedido_credito_multiple`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

Con tu pago a {{4}} días abonás: {{5}}

Pagando al contado ahorrarías {{6}}.

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
`{{4}}` = plazo elegido: `15 a 30` / `31 a 45` / `46 a 60`.
Ejemplos: `{{1}}`=`$500.000,00` · `{{2}}`=`3` · `{{3}}`=`$153.355,46 $200.100,00 $146.544,54` · `{{4}}`=`31 a 45` · `{{5}}`=`$425.000,00` · `{{6}}`=`$50.000,00`

### 6 · `pedido_echeq_multiple`
```
¡Hola! Tu pedido está listo y estará con vos a la brevedad.

Total de tus facturas (con IVA): {{1}}, en {{2}} facturas.

Detalle por factura: {{3}}

Con tu pago por e-cheq abonás: {{4}}
Recordá enviar el e-cheq de manera anticipada.

Pagando al contado ahorrarías {{5}}.

Datos para el pago:
Alias: loeke.srl
CBU: 1910027855002702387450
```
Ejemplos: `{{1}}`=`$500.000,00` · `{{2}}`=`3` · `{{3}}`=`$153.355,46 $200.100,00 $146.544,54` · `{{4}}`=`$475.000,00` · `{{5}}`=`$100.000,00`

---

## Cómo el bot elige y llena (referencia técnica)

`supabase/functions/lk_factura-consolidar` decide:
- **Grupo por método** (`wa_metodo_norm` sobre `condicion_venta` de la factura):
  contado / no_decidido → contado · credito_* → credito · echeq_* → echeq.
- **Single vs múltiple**: según cantidad de facturas del pedido.
- **Descuentos** (`wa_descuentos_metodo`, default): contado 25%, 15-30d 20%, 31-45d 15%,
  46-60d 10%, e-cheq 90d 5%, e-cheq 120d 0%. `no_decidido` se muestra como contado.

Crédito y e-cheq muestran ambos **la diferencia** (`ahorroVsContado` = lo que ahorraría
pagando al contado), con la línea "Pagando al contado ahorrarías X." Contado/sin definir
muestran el monto a pagar al contado.

Nombres configurables en `app_settings` (PaginaLK): `wa_tpl_contado`, `wa_tpl_credito`,
`wa_tpl_echeq`, `wa_tpl_contado_multiple`, `wa_tpl_credito_multiple`, `wa_tpl_echeq_multiple`.

## Límite de caracteres (confirmado con docs de Meta / BSPs)
- **Cuerpo (body): 1024 caracteres.** Los `{{n}}` cuentan como 1 char en la definición, pero
  **al enviar, el cuerpo ya con los valores sustituidos tampoco puede pasar de 1024**.
- **Encabezado (texto): 60** · **Pie de página: 60** · **Botón: 25** (no usamos texto en header/footer variable).

Peor caso = crédito múltiple: texto fijo ~200 + valores ~50 + lista `{{3}}` ≈ 14 chars por
factura. Para no pasar 1024: `14 × N ≤ ~770` → caben **~55 facturas** en un mismo pedido.
Un pedido real se parte en 2-6, así que no hay riesgo práctico. Si algún día un pedido tuviera
decenas de facturas, acortar el formato de la lista `{{3}}`.

## Estado
Plantillas listas para cargar. El bot ya las selecciona y completa (deploy v8), **sin envío**:
todo el pipeline queda dormant hasta empezar los testeos con mensajes reales.
