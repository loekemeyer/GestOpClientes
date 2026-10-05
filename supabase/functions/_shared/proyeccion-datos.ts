// GENERADO por scripts/proyeccion-avisos/generar.mjs a partir de scripts/proyeccion-avisos/datos-base.json. No editar a mano.
// Informe "Proyección de avisos y gasto" del dashboard (Informes). Sólo agregados: ningún dato de clientes.
// deno-lint-ignore-file
export const PROYECCION_DATOS = {
 "generado": "2026-10-05",
 "tarifa": {
  "utility": 0.026,
  "marketing": 0.0618
 },
 "meses": [
  {
   "id": "2026-06",
   "nombre": "Jun",
   "parcial": false
  },
  {
   "id": "2026-07",
   "nombre": "Jul",
   "parcial": false
  },
  {
   "id": "2026-08",
   "nombre": "Ago",
   "parcial": false
  },
  {
   "id": "2026-09",
   "nombre": "Sep",
   "parcial": false
  },
  {
   "id": "2026-10",
   "nombre": "Oct (1 al 5)",
   "parcial": true
  }
 ],
 "pedidos": {
  "2026-06": {
   "total": 157,
   "conTel": 137,
   "cancelados": 0,
   "modo": {
    "reparto": 61,
    "expreso": 74,
    "retira": 22
   },
   "enCurso": 0,
   "avisos": 532
  },
  "2026-07": {
   "total": 219,
   "conTel": 173,
   "cancelados": 0,
   "modo": {
    "reparto": 77,
    "expreso": 118,
    "retira": 24
   },
   "enCurso": 0,
   "avisos": 734
  },
  "2026-08": {
   "total": 212,
   "conTel": 179,
   "cancelados": 0,
   "modo": {
    "reparto": 79,
    "expreso": 107,
    "retira": 26
   },
   "enCurso": 0,
   "avisos": 715
  },
  "2026-09": {
   "total": 194,
   "conTel": 163,
   "cancelados": 18,
   "modo": {
    "reparto": 94,
    "expreso": 76,
    "retira": 24
   },
   "enCurso": 82,
   "avisos": 676
  },
  "2026-10": {
   "total": 21,
   "conTel": 18,
   "cancelados": 1,
   "modo": {
    "reparto": 7,
    "expreso": 13,
    "retira": 1
   },
   "enCurso": 21,
   "avisos": 68
  }
 },
 "plantillas": [
  {
   "id": "pedido_recordatorio_descuento",
   "etiqueta": "Recordatorio de descuento por vencer",
   "grupo": "Recordatorio",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 405,
     "conTel": 335,
     "falta": 0
    },
    "2026-07": {
     "todos": 309,
     "conTel": 290,
     "falta": 0
    },
    "2026-08": {
     "todos": 245,
     "conTel": 230,
     "falta": 0
    },
    "2026-09": {
     "todos": 287,
     "conTel": 264,
     "falta": 0
    },
    "2026-10": {
     "todos": 28,
     "conTel": 27,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_recibido",
   "etiqueta": "Pedido recibido",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 157,
     "conTel": 137,
     "falta": 0
    },
    "2026-07": {
     "todos": 219,
     "conTel": 173,
     "falta": 0
    },
    "2026-08": {
     "todos": 212,
     "conTel": 179,
     "falta": 0
    },
    "2026-09": {
     "todos": 212,
     "conTel": 178,
     "falta": 0
    },
    "2026-10": {
     "todos": 22,
     "conTel": 19,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_contado_s",
   "etiqueta": "Factura contado · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 84,
     "conTel": 71,
     "falta": 0
    },
    "2026-07": {
     "todos": 82,
     "conTel": 71,
     "falta": 0
    },
    "2026-08": {
     "todos": 121,
     "conTel": 100,
     "falta": 0
    },
    "2026-09": {
     "todos": 105,
     "conTel": 90,
     "falta": 0
    },
    "2026-10": {
     "todos": 11,
     "conTel": 10,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_programado_expreso",
   "etiqueta": "Programado · expreso",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 74,
     "conTel": 65,
     "falta": 0
    },
    "2026-07": {
     "todos": 118,
     "conTel": 84,
     "falta": 0
    },
    "2026-08": {
     "todos": 107,
     "conTel": 95,
     "falta": 0
    },
    "2026-09": {
     "todos": 73,
     "conTel": 61,
     "falta": 0
    },
    "2026-10": {
     "todos": 13,
     "conTel": 10,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_en_viaje_expreso",
   "etiqueta": "Entregado al expreso",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 74,
     "conTel": 65,
     "falta": 0
    },
    "2026-07": {
     "todos": 118,
     "conTel": 84,
     "falta": 0
    },
    "2026-08": {
     "todos": 107,
     "conTel": 95,
     "falta": 0
    },
    "2026-09": {
     "todos": 73,
     "conTel": 61,
     "falta": 28
    },
    "2026-10": {
     "todos": 13,
     "conTel": 10,
     "falta": 13
    }
   }
  },
  {
   "id": "pedido_programado",
   "etiqueta": "Programado · reparto",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 61,
     "conTel": 51,
     "falta": 0
    },
    "2026-07": {
     "todos": 77,
     "conTel": 65,
     "falta": 0
    },
    "2026-08": {
     "todos": 79,
     "conTel": 59,
     "falta": 0
    },
    "2026-09": {
     "todos": 90,
     "conTel": 77,
     "falta": 0
    },
    "2026-10": {
     "todos": 6,
     "conTel": 6,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_en_viaje",
   "etiqueta": "Salió en el camión · reparto",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 61,
     "conTel": 51,
     "falta": 0
    },
    "2026-07": {
     "todos": 77,
     "conTel": 65,
     "falta": 0
    },
    "2026-08": {
     "todos": 79,
     "conTel": 59,
     "falta": 0
    },
    "2026-09": {
     "todos": 90,
     "conTel": 77,
     "falta": 45
    },
    "2026-10": {
     "todos": 6,
     "conTel": 6,
     "falta": 6
    }
   }
  },
  {
   "id": "pedido_entregado",
   "etiqueta": "Entregado · reparto",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 61,
     "conTel": 51,
     "falta": 0
    },
    "2026-07": {
     "todos": 77,
     "conTel": 65,
     "falta": 0
    },
    "2026-08": {
     "todos": 79,
     "conTel": 59,
     "falta": 0
    },
    "2026-09": {
     "todos": 90,
     "conTel": 77,
     "falta": 45
    },
    "2026-10": {
     "todos": 6,
     "conTel": 6,
     "falta": 6
    }
   }
  },
  {
   "id": "pedido_contado_p",
   "etiqueta": "Factura contado · varias facturas",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 48,
     "conTel": 45,
     "falta": 0
    },
    "2026-07": {
     "todos": 55,
     "conTel": 44,
     "falta": 0
    },
    "2026-08": {
     "todos": 80,
     "conTel": 64,
     "falta": 0
    },
    "2026-09": {
     "todos": 66,
     "conTel": 60,
     "falta": 0
    },
    "2026-10": {
     "todos": 3,
     "conTel": 3,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_programado_retira",
   "etiqueta": "Programado · retira",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 22,
     "conTel": 21,
     "falta": 0
    },
    "2026-07": {
     "todos": 24,
     "conTel": 24,
     "falta": 0
    },
    "2026-08": {
     "todos": 26,
     "conTel": 25,
     "falta": 0
    },
    "2026-09": {
     "todos": 24,
     "conTel": 23,
     "falta": 0
    },
    "2026-10": {
     "todos": 1,
     "conTel": 1,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_listo_retirar",
   "etiqueta": "Listo para retirar",
   "grupo": "Seguimiento del pedido",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 22,
     "conTel": 21,
     "falta": 0
    },
    "2026-07": {
     "todos": 24,
     "conTel": 24,
     "falta": 0
    },
    "2026-08": {
     "todos": 26,
     "conTel": 25,
     "falta": 0
    },
    "2026-09": {
     "todos": 24,
     "conTel": 23,
     "falta": 1
    },
    "2026-10": {
     "todos": 1,
     "conTel": 1,
     "falta": 1
    }
   }
  },
  {
   "id": "pedido_contado_s_chef",
   "etiqueta": "Factura contado · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "chef",
   "porMes": {
    "2026-06": {
     "todos": 15,
     "conTel": null,
     "falta": 0
    },
    "2026-07": {
     "todos": 15,
     "conTel": null,
     "falta": 0
    },
    "2026-08": {
     "todos": 15,
     "conTel": null,
     "falta": 0
    },
    "2026-09": {
     "todos": 27,
     "conTel": null,
     "falta": 0
    },
    "2026-10": {
     "todos": 3,
     "conTel": null,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_contado_p_chef",
   "etiqueta": "Factura contado · varias facturas",
   "grupo": "Factura y pago",
   "empresa": "chef",
   "porMes": {
    "2026-06": {
     "todos": 13,
     "conTel": null,
     "falta": 0
    },
    "2026-07": {
     "todos": 16,
     "conTel": null,
     "falta": 0
    },
    "2026-08": {
     "todos": 15,
     "conTel": null,
     "falta": 0
    },
    "2026-09": {
     "todos": 23,
     "conTel": null,
     "falta": 0
    },
    "2026-10": {
     "todos": 2,
     "conTel": null,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_credito_s",
   "etiqueta": "Factura crédito · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 17,
     "conTel": 14,
     "falta": 0
    },
    "2026-07": {
     "todos": 12,
     "conTel": 11,
     "falta": 0
    },
    "2026-08": {
     "todos": 22,
     "conTel": 22,
     "falta": 0
    },
    "2026-09": {
     "todos": 15,
     "conTel": 13,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": 0,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_credito_p",
   "etiqueta": "Factura crédito · varias facturas",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 10,
     "conTel": 6,
     "falta": 0
    },
    "2026-07": {
     "todos": 13,
     "conTel": 13,
     "falta": 0
    },
    "2026-08": {
     "todos": 17,
     "conTel": 14,
     "falta": 0
    },
    "2026-09": {
     "todos": 16,
     "conTel": 14,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": 0,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_echeq_s",
   "etiqueta": "Factura e-cheq · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 6,
     "conTel": 5,
     "falta": 0
    },
    "2026-07": {
     "todos": 3,
     "conTel": 3,
     "falta": 0
    },
    "2026-08": {
     "todos": 2,
     "conTel": 2,
     "falta": 0
    },
    "2026-09": {
     "todos": 4,
     "conTel": 4,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": 0,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_credito_s_chef",
   "etiqueta": "Factura crédito · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "chef",
   "porMes": {
    "2026-06": {
     "todos": 4,
     "conTel": null,
     "falta": 0
    },
    "2026-07": {
     "todos": 2,
     "conTel": null,
     "falta": 0
    },
    "2026-08": {
     "todos": 3,
     "conTel": null,
     "falta": 0
    },
    "2026-09": {
     "todos": 2,
     "conTel": null,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_echeq_p",
   "etiqueta": "Factura e-cheq · varias facturas",
   "grupo": "Factura y pago",
   "empresa": "lk",
   "porMes": {
    "2026-06": {
     "todos": 1,
     "conTel": 1,
     "falta": 0
    },
    "2026-07": {
     "todos": 2,
     "conTel": 2,
     "falta": 0
    },
    "2026-08": {
     "todos": 2,
     "conTel": 1,
     "falta": 0
    },
    "2026-09": {
     "todos": 2,
     "conTel": 2,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": 0,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_credito_p_chef",
   "etiqueta": "Factura crédito · varias facturas",
   "grupo": "Factura y pago",
   "empresa": "chef",
   "porMes": {
    "2026-06": {
     "todos": 2,
     "conTel": null,
     "falta": 0
    },
    "2026-08": {
     "todos": 1,
     "conTel": null,
     "falta": 0
    },
    "2026-09": {
     "todos": 2,
     "conTel": null,
     "falta": 0
    },
    "2026-07": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    }
   }
  },
  {
   "id": "pedido_echeq_s_chef",
   "etiqueta": "Factura e-cheq · 1 factura",
   "grupo": "Factura y pago",
   "empresa": "chef",
   "porMes": {
    "2026-06": {
     "todos": 1,
     "conTel": null,
     "falta": 0
    },
    "2026-07": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    },
    "2026-08": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    },
    "2026-09": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    },
    "2026-10": {
     "todos": 0,
     "conTel": null,
     "falta": 0
    }
   }
  }
 ],
 "totales": {
  "2026-06": {
   "todos": 1138,
   "conTel": 939,
   "falta": 0
  },
  "2026-07": {
   "todos": 1243,
   "conTel": 1018,
   "falta": 0
  },
  "2026-08": {
   "todos": 1238,
   "conTel": 1029,
   "falta": 0
  },
  "2026-09": {
   "todos": 1225,
   "conTel": 1024,
   "falta": 119
  },
  "2026-10": {
   "todos": 115,
   "conTel": 99,
   "falta": 26
  }
 },
 "notas": [
  "Cuenta lo que dispararían HOY los disparadores del sistema (registro del pedido, cambios de estado, retiro y salida de pedidos web, facturas y recordatorio de descuento) si todos los clientes tuvieran teléfono. \"Con teléfono\" cuenta sólo a los clientes que ya tienen un número en el ERP o en el bot; hoy, en cambio, el trigger sólo avisa a los agendados en el bot (2 clientes).",
  "Pedidos web de LK: cada pedido genera 4 avisos si es reparto (recibido, programado, salió en el camión y entregado) y 3 si es por expreso o retiro. Se descuentan los cancelados (salvo en el aviso de recibido, que salió antes de cancelarse), pero sólo están registrados desde septiembre: los meses anteriores pueden estar algo inflados. Es un tope: supone que todos los avisos de salida llegan a salir.",
  "Los pedidos todavía en curso (septiembre y octubre) se cuentan con su recorrido completo; la fila \"Aún sin salir\" dice cuántos de esos avisos todavía no salieron. Un pedido que quedó sin programar sólo cuenta su aviso de recibido.",
  "No incluye pedido_reprogramado: antes del 28/09 no se guardó el historial de cambios de fecha. En septiembre hubo al menos 10 reprogramaciones de pedidos diferidos, así que el número real es mayor a cero.",
  "Facturas: un mensaje por cliente, día y método de pago, con la regla de lk_factura-check (\"no decidido\" se suma a contado). Agosto más septiembre da 434 mensajes de LK; la simulación del 29/09 contó 431 para 31/07 al 28/09. Un cliente con dos direcciones el mismo día recibiría dos mensajes y acá cuenta uno, así que el número queda levemente por debajo.",
  "Recordatorio de descuento: un aviso 2 días hábiles antes de cada escalón (14, 30, 45 y 60 días de la factura) mientras la factura siga sin pagar. Los meses pasados se calculan con las fechas de pago reales. Usa la versión v5 (utilidad): si Meta la tomara como marketing, cada aviso pasaría de US$ 0,026 a US$ 0,0618.",
  "Costo: cada aviso a la tarifa de utilidad de Argentina (US$ 0,026). Según el cambio de Meta del 01/10 (a confirmar con la primera factura), la utilidad se cobra aunque la ventana de 24 h esté abierta; antes esos avisos salían gratis, así que para meses anteriores es el costo que tendrían hoy, no el que se habría pagado.",
  "Chef: sólo cuentan sus facturas (el seguimiento de pedidos es de LK) y no se pudo cruzar su teléfono, por eso no entra en \"Con teléfono\".",
  "Los pedidos de Gestión se guardan unas 4 semanas: para los pedidos anteriores al 07/09 se supone que ya terminaron su recorrido."
 ],
 "ia": {
  "_nota": "Dos cargas del estudio de consultas, ya agrupadas por causa: no hay fecha por mensaje, por eso se muestra un mes promedio (30 días) y no mes a mes.",
  "bases": [
   {
    "id": "jul_sep",
    "nombre": "Consultas del 28/07 al 28/09",
    "dias": 63,
    "consultas": 712,
    "saludos": 108,
    "contactos": 236,
    "metodo": {
     "plantilla": 347,
     "plantillaAgente": 0,
     "agente": 365
    },
    "hoy": {
     "conIa": 195,
     "sinIa": 517
    },
    "nota": "11 ejemplos, uno por causa, que pesan las 712 consultas: el reparto 'hoy' sale de un solo caso por causa."
   },
   {
    "id": "ene_jun",
    "nombre": "Consultas del 01/01 al 09/06 (clientes con código)",
    "dias": 160,
    "consultas": 1013,
    "saludos": 0,
    "contactos": null,
    "metodo": {
     "plantilla": 420,
     "plantillaAgente": 120,
     "agente": 473
    },
    "hoy": {
     "conIa": 356,
     "sinIa": 657
    },
    "nota": "71 casos simulados uno por uno (29 con IA, 42 sin IA)."
   }
  ],
  "parametros": {
   "llamadasPorConsultaIa": 1.8,
   "usdPorLlamada": {
    "sonnet": 0.032,
    "haiku": 0.011,
    "sonnetConCache": 0.021
   },
   "usdPorSaludo": 0.014,
   "topeServicioGratisPorNumero": 1000
  }
 }
};
