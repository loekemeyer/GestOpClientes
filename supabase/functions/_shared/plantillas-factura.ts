// plantillas-factura — texto de las 6 plantillas de factura tal como están aprobadas en Meta (foto del 29/09), para el
// Simulador del dashboard (lk_bot-simular). Las MANDA lk_factura-check, que arma sus variables; este archivo no se usa
// para enviar. Si se edita una plantilla en Meta, actualizar el texto acá.
export const PLANTILLAS_FACTURA: Array<{ name: string; disparo: string; body: string; ejemplos: string[] }> = [
  {
    "name": "pedido_contado_s",
    "disparo": "Se factura el pedido y el cliente paga contado (una factura). Sale con la factura en PDF (lk_factura-check).",
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal de tu factura (con IVA): {{1}}\n\n*Total a pagar Contado ({{2}}% Dto): {{3}}*\n\nDatos para el pago:\nAlias: {{4}}\nCBU: {{5}}\n\nSaludos.",
    "ejemplos": [
      "$470.499",
      "25",
      "$352.874",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_contado_p",
    "disparo": "Se factura el pedido y el cliente paga contado (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 29/09: el total a pagar va primero y el detalle antes del total. Hay que editarla así en WhatsApp Manager;
    // lk_factura-check ordena las variables según el texto que Meta tenga aprobado (ordenContado).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal a pagar *Contado ({{1}}% Dto)*: *{{2}}*\n\nDetalle por factura: {{3}}\nTotal de tus facturas (con IVA): {{4}}, en {{5}} facturas.\n\nDatos para el pago:\nAlias: {{6}}\nCBU: {{7}}\n\nSaludos.",
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
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal de tu factura (con IVA): {{1}}\n\n*Con tu pago a {{2}} días abonás: {{3}} ({{4}}% Dto)*\n\n*Pagando hasta el {{5}} podés ahorrarte {{6}}.*\n*Total Contado: {{7}}*\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": [
      "$743.418",
      "31 a 45",
      "$631.905",
      "15",
      "15/09/2026",
      "$74.342",
      "$557.564",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_credito_p",
    "disparo": "Se factura el pedido y el cliente paga a crédito (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal de tus facturas (con IVA): {{1}}, en {{2}} facturas.\n\nDetalle por factura: {{3}}\n\n*Con tu pago a {{4}} días abonás: {{5}} ({{6}}% Dto)*\n\n*Pagando hasta el {{7}} podés ahorrarte {{8}}.*\n*Total Contado: {{9}}*\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": [
      "$500.000",
      "3",
      "$153.355 / $200.100 / $146.545",
      "31 a 45",
      "$425.000",
      "15",
      "15/09/2026",
      "$50.000",
      "$375.000",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_echeq_s",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (una factura). Sale con la factura en PDF (lk_factura-check).",
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal de tu factura (con IVA): {{1}}\n\n*Con tu pago por e-cheq a {{2}} días abonás: {{3}} ({{4}}% Dto)*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\n*Pagando hasta el {{5}} podés ahorrarte {{6}}.*\n*Total Contado: {{7}}*\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": [
      "$1.587.098",
      "90",
      "$1.507.743",
      "5",
      "15/09/2026",
      "$317.420",
      "$1.190.324",
      "loeke.srl",
      "1910027855002702387450"
    ]
  },
  {
    "name": "pedido_echeq_p",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal de tus facturas (con IVA): {{1}}, en {{2}} facturas.\n\nDetalle por factura: {{3}}\n\n*Con tu pago por e-cheq a {{4}} días abonás: {{5}} ({{6}}% Dto)*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\n*Pagando hasta el {{7}} podés ahorrarte {{8}}.*\n*Total Contado: {{9}}*\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": [
      "$500.000",
      "3",
      "$153.355 / $200.100 / $146.545",
      "90",
      "$475.000",
      "5",
      "15/09/2026",
      "$100.000",
      "$375.000",
      "loeke.srl",
      "1910027855002702387450"
    ]
  }
];
