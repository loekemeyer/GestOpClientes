// plantillas-factura — texto de las 6 plantillas de factura. Es la FUENTE: lk_templates action factura_sync lo sube a
// Meta (siempre como versión nueva, base_vN; Pablo 30/09) y el Simulador del dashboard (lk_bot-simular) lo muestra.
// Las MANDA lk_factura-check, que ordena las variables según el texto de la versión activa (mapearPorTexto).
// Pablo, 30/09 (auditoría): abren con "Te adjuntamos la factura de tu pedido." (antes "estará con vos a la brevedad",
// falso para quien retira).
export type PlantillaFactura = { name: string; disparo: string; body: string; ejemplos: string[]; empresa?: "chef" };

const PLANTILLAS_FACTURA_LK: PlantillaFactura[] = [
  {
    "name": "pedido_contado_s",
    "disparo": "Se factura el pedido y el cliente paga contado (una factura). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: el total a pagar va primero, igual que pedido_contado_p (lk_factura-check ordena las variables
    // según el texto aprobado en Meta: ordenContado).
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar *Contado ({{1}}% Dto)*: *{{2}}*\n\nTotal de tu factura (con IVA): {{3}}\n\nDatos para el pago:\nAlias: {{4}}\nCBU: {{5}}\n\nSaludos.",
    "ejemplos": [
      "25",
      "$352.874",
      "$470.499",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_contado_p",
    "disparo": "Se factura el pedido y el cliente paga contado (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 29/09: el total a pagar va primero y el detalle antes del total. Hay que editarla así en WhatsApp Manager;
    // lk_factura-check ordena las variables según el texto que Meta tenga aprobado (ordenContado).
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar *Contado ({{1}}% Dto)*: *{{2}}*\n\nDetalle por factura: {{3}}\nTotal de tus facturas (con IVA): {{4}}, en {{5}} facturas.\n\nDatos para el pago:\nAlias: {{6}}\nCBU: {{7}}\n\nSaludos.",
    "ejemplos": [
      "25",
      "$375.000",
      "$153.355 / $200.100 / $146.545",
      "$500.000",
      "3",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_credito_s",
    "disparo": "Se factura el pedido y el cliente paga a crédito (una factura). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: crédito con la fecha hasta la que vale el descuento (factura + último día del plazo), el ahorro de contado y al final el total.
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar al {{1}} ({{2}}% dto) abonás *{{3}}*\n\n*Pagando hasta el {{4}} podés ahorrarte {{5}}.*\n*Total Contado: {{6}}*\n\nTotal de tu factura (con IVA): {{7}}\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": ["12/11", "15", "$631.905", "12/10", "$74.342", "$557.564", "$743.418", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_credito_p",
    "disparo": "Se factura el pedido y el cliente paga a crédito (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: crédito con la fecha hasta la que vale el descuento (factura + último día del plazo), el ahorro de contado y al final el total.
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar al {{1}} ({{2}}% dto) abonás *{{3}}*\n\n*Pagando hasta el {{4}} podés ahorrarte {{5}}.*\n*Total Contado: {{6}}*\n\nDetalle por factura: {{7}}\nTotal de tus facturas (con IVA): {{8}}, en {{9}} facturas.\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": ["12/11", "15", "$425.000", "12/10", "$50.000", "$375.000", "$153.355 / $200.100 / $146.545", "$500.000", "3", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_echeq_s",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (una factura). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: e-cheq con la fecha del cheque (factura + días del plazo), el ahorro de contado y al final el total.
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar Echeq al {{1}} ({{2}}% dto) abonás *{{3}}*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\n*Pagando hasta el {{4}} podés ahorrarte {{5}}.*\n*Total Contado: {{6}}*\n\nTotal de tu factura (con IVA): {{7}}\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": ["26/01", "0", "$1.587.098", "12/10", "$396.775", "$1.190.324", "$1.587.098", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_echeq_p",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: e-cheq con la fecha del cheque (factura + días del plazo), el ahorro de contado y al final el total.
    "body": "¡Hola! Te adjuntamos la factura de tu pedido.\n\nTotal a pagar Echeq al {{1}} ({{2}}% dto) abonás *{{3}}*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\n*Pagando hasta el {{4}} podés ahorrarte {{5}}.*\n*Total Contado: {{6}}*\n\nDetalle por factura: {{7}}\nTotal de tus facturas (con IVA): {{8}}, en {{9}} facturas.\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": ["27/12", "5", "$475.000", "12/10", "$100.000", "$375.000", "$153.355 / $200.100 / $146.545", "$500.000", "3", "loeke.srl", "1910027855002702387450"]
  }
];

// Chef (Pablo, 01/10): Chef no tiene alias (Cobranzas de Chef pasa CBU, titular y CUIT) y comparte el número de WhatsApp con
// Loekemeyer, así que cada una de las 6 tiene su versión de Chef: nombra a Chef, NO lleva la línea de alias y el pie es
//   Titular: CHEF S.R.L. (CUIT …)   ← texto fijo: lk_factura-check reconoce cada variable por la línea que la rodea
//   CBU: {{n}}                       ← variable: cambiar de cuenta no necesita una aprobación nueva de Meta
// Se derivan de las de Loekemeyer para que la estructura (orden de variables, descuentos, fechas) sea la misma; si cambia el
// texto de una de LK hay que subir también su versión de Chef (factura_sync las lista juntas).
export const CHEF_TITULAR = "CHEF S.R.L. (CUIT 30-68575625-7)";
const CHEF_CBU_EJEMPLO = "0720058820000000488554";

function paraChef(p: PlantillaFactura): PlantillaFactura {
  const pie = p.body.match(/Alias: \{\{(\d+)\}\}\nCBU: \{\{(\d+)\}\}/);
  if (!pie) throw new Error(`plantilla ${p.name}: no encontré el pie de pago (Alias/CBU)`);
  if (!p.body.includes("la factura de tu pedido.")) throw new Error(`plantilla ${p.name}: no encontré el saludo`);
  return {
    name: `${p.name}_chef`,
    empresa: "chef",
    disparo: p.disparo.replace("Se factura el pedido", "Se factura un pedido de Chef"),
    // El CBU toma el número que tenía el alias (eran las dos últimas variables).
    body: p.body.replace("la factura de tu pedido.", "la factura de tu pedido de Chef.")
      .replace(pie[0], `Titular: ${CHEF_TITULAR}\nCBU: {{${pie[1]}}}`),
    ejemplos: [...p.ejemplos.slice(0, -2), CHEF_CBU_EJEMPLO],
  };
}

export const PLANTILLAS_FACTURA: PlantillaFactura[] = [...PLANTILLAS_FACTURA_LK, ...PLANTILLAS_FACTURA_LK.map(paraChef)];
