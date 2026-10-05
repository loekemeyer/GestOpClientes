// Pruebas de las cuentas del aviso de factura (supabase/functions/_shared/factura-valores.ts). Lógica pura, sin red.
// Las usan el aviso real (lk_factura-check) y el Simulador (lk_bot-simular).
// Correr: deno run tests/factura-valores.test.ts   (sale con código 1 si algo falla)
import { armarDtoCfg, cuentasFactura, diasDelPlazo, fmtARS, grupoDe, mapearPorTexto, metodoExcepcion, planMetodos } from "../supabase/functions/_shared/factura-valores.ts";
import { PLANTILLAS_FACTURA } from "../supabase/functions/_shared/plantillas-factura.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// La tabla del Panel (wa_descuentos_config) del 05/10, sin la ficha de empresas.
const cfg = armarDtoCfg({
  pago: { alias: "loeke.srl", cbu: "1910027855002702387450" },
  contado: { dto: 0.25, dias_limite: 14 },
  credito: [{ dto: 0.20, key: "credito_15_30", label: "15 a 30" }, { dto: 0.15, key: "credito_31_45", label: "31 a 45" }],
  echeq: [{ dto: 0.05, key: "echeq_90", label: "90" }],
  excepciones: { credito_31_45: [{ tipo: "cuit", valor: "30-71234567-8" }] },
}, "lk", "v2");

igual("cfg: alias", cfg.alias, "loeke.srl");
igual("cfg: sin config usa defaults", armarDtoCfg(null).contadoDto, 0.25);
igual("cfg: Chef sin CBU retiene", armarDtoCfg({ empresas: { chef: {} } }, "chef").sinDatosPago, true);
igual("pesos", fmtARS(17358008.86), "$17.358.009");
igual("grupo de la plantilla", ["contado_p", "credito_s", "echeq_p"].map(grupoDe), ["contado", "credito", "echeq"]);
igual("días del plazo: crédito", diasDelPlazo("31 a 45", "credito_31_45"), 45);
igual("días del plazo: e-cheq por la clave", diasDelPlazo("", "echeq_120"), 120);
igual("días del plazo: contado", diasDelPlazo("", "contado"), null);
igual("excepción por CUIT", metodoExcepcion(cfg, "30712345678", null), "credito_31_45");

// Las 3 facturas reales de Torres y Liva (288) del 25/09, contado.
const c = cuentasFactura("contado", [10603863.77, 5886307.40, 867837.69], cfg);
igual("288: plantilla de varias", c.template, "pedido_contado_p");
igual("288: total", fmtARS(c.total_sum), "$17.358.009");
igual("288: contado 25%", fmtARS(c.montoContado), "$13.018.507");
igual("288: detalle", c.lista, "$10.603.864 / $5.886.307 / $867.838");
const body = PLANTILLAS_FACTURA.find((p) => p.name === c.template)!.body;
igual("288: variables en el orden del texto", mapearPorTexto(body, {
  total: fmtARS(c.total_sum), n: String(c.n), lista: c.lista, plazo: c.label, pct: c.contadoPct, montoCliente: fmtARS(c.montoCliente),
  montoContado: fmtARS(c.montoContado), fecha: "09/10", ahorro: fmtARS(c.ahorro), alias: cfg.alias, cbu: cfg.cbu, fechaPlazo: "la fecha acordada",
}, c.grupo), ["25", "$13.018.507", "$10.603.864 / $5.886.307 / $867.838", "$17.358.009", "3", "loeke.srl", "1910027855002702387450"]);

// Crédito 31 a 45, una factura: abona con 15%, ahorra la diferencia con contado.
const cr = cuentasFactura("credito_31_45", [100000], cfg);
igual("crédito: plantilla", cr.template, "pedido_credito_s");
igual("crédito: abona y ahorro", [fmtARS(cr.montoCliente), fmtARS(cr.ahorro), cr.metodoPct], ["$85.000", "$10.000", "15"]);

// Método mixto (reglas A y B).
igual("regla A: no decidido adopta el único método", planMetodos([{ total: 1, metodo: "credito_15_30" }, { total: 2, metodo: "no_decidido" }], cfg)
  .map((s) => [s.metodo, s.facturas.length]), [["credito_15_30", 2]]);
igual("regla B: se parte y no decidido va a contado", planMetodos([{ total: 1, metodo: "echeq_90" }, { total: 2, metodo: "contado" },
  { total: 3, metodo: "no_decidido" }], cfg).map((s) => [s.metodo, s.facturas.length]), [["contado", 2], ["echeq_90", 1]]);
igual("excepción: no se parte", planMetodos([{ total: 1, metodo: "echeq_90" }, { total: 2, metodo: "contado" }], cfg, "credito_31_45")
  .map((s) => [s.metodo, s.facturas.length]), [["credito_31_45", 2]]);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
