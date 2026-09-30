// plantillas-factura — texto de las 6 plantillas de factura. Es la FUENTE: lk_templates action factura_sync lo sube a
// Meta (siempre como versión nueva, base_vN; Pablo 30/09) y el Simulador del dashboard (lk_bot-simular) lo muestra.
// Las MANDA lk_factura-check, que ordena las variables según el texto de la versión activa (mapearPorTexto).
export const PLANTILLAS_FACTURA: Array<{ name: string; disparo: string; body: string; ejemplos: string[] }> = [
  {
    "name": "pedido_contado_s",
    "disparo": "Se factura el pedido y el cliente paga contado (una factura). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: el total a pagar va primero, igual que pedido_contado_p (lk_factura-check ordena las variables
    // según el texto aprobado en Meta: ordenContado).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nTotal a pagar *Contado ({{1}}% Dto)*: *{{2}}*\n\nTotal de tu factura (con IVA): {{3}}\n\nDatos para el pago:\nAlias: {{4}}\nCBU: {{5}}\n\nSaludos.",
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
    // Pablo, 30/09: formato nuevo (lo que paga arriba, el detalle antes del total).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nCon tu pago a *{{1}} días ({{2}}% Dto)* abonás: *{{3}}*\n\nTotal de tu factura (con IVA): {{4}}\n\n*Pagando hasta el {{5}} podés ahorrarte {{6}}.*\n*Total Contado: {{7}}*\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": ["31 a 45", "15", "$631.905", "$743.418", "15/09/2026", "$74.342", "$557.564", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_credito_p",
    "disparo": "Se factura el pedido y el cliente paga a crédito (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: formato nuevo (lo que paga arriba, el detalle antes del total).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nCon tu pago a *{{1}} días ({{2}}% Dto)* abonás: *{{3}}*\n\nDetalle por factura: {{4}}\nTotal de tus facturas (con IVA): {{5}}, en {{6}} facturas.\n\n*Pagando hasta el {{7}} podés ahorrarte {{8}}.*\n*Total Contado: {{9}}*\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": ["31 a 45", "15", "$425.000", "$153.355 / $200.100 / $146.545", "$500.000", "3", "15/09/2026", "$50.000", "$375.000", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_echeq_s",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (una factura). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: formato nuevo (lo que paga arriba, el detalle antes del total).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nCon tu pago por e-cheq a *{{1}} días ({{2}}% Dto)* abonás: *{{3}}*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\nTotal de tu factura (con IVA): {{4}}\n\n*Pagando hasta el {{5}} podés ahorrarte {{6}}.*\n*Total Contado: {{7}}*\n\nDatos para el pago:\nAlias: {{8}}\nCBU: {{9}}\n\nSaludos.",
    "ejemplos": ["90", "5", "$1.507.743", "$1.587.098", "15/09/2026", "$317.420", "$1.190.324", "loeke.srl", "1910027855002702387450"]
  },
  {
    "name": "pedido_echeq_p",
    "disparo": "Se factura el pedido y el cliente paga con e-cheq (varias facturas). Sale con la factura en PDF (lk_factura-check).",
    // Pablo, 30/09: formato nuevo (lo que paga arriba, el detalle antes del total).
    "body": "¡Hola! Tu pedido está listo y estará con vos a la brevedad.\n\nCon tu pago por e-cheq a *{{1}} días ({{2}}% Dto)* abonás: *{{3}}*\nRecordá enviar el e-cheq al momento de recibir el pedido.\n\nDetalle por factura: {{4}}\nTotal de tus facturas (con IVA): {{5}}, en {{6}} facturas.\n\n*Pagando hasta el {{7}} podés ahorrarte {{8}}.*\n*Total Contado: {{9}}*\n\nDatos para el pago:\nAlias: {{10}}\nCBU: {{11}}\n\nSaludos.",
    "ejemplos": ["90", "5", "$475.000", "$153.355 / $200.100 / $146.545", "$500.000", "3", "15/09/2026", "$100.000", "$375.000", "loeke.srl", "1910027855002702387450"]
  }
];
