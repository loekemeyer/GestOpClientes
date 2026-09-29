// Artifact "Qué pasa cuando se hace un pedido web": recorrido paso a paso de los avisos (pedido de Pablo Olejavetzky, 29/09).
//   node generar.mjs <datos.json de plantillas-artifact> <salida.html>
// Toma de datos.json sólo las plantillas del recorrido (texto tal cual está en Meta) y la llave de envíos.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const aca = dirname(fileURLToPath(import.meta.url));
const [, , entrada, salida] = process.argv;
const d = JSON.parse(readFileSync(entrada, "utf8"));
const usa = ["pedido_recibido", "pedido_programado", "pedido_programado_expreso", "pedido_programado_retira", "pedido_reprogramado",
  "pedido_preparando", "pedido_contado_s", "pedido_listo_retirar", "pedido_entregado", "pedido_en_viaje_expreso"];
const plantillas = d.plantillas.filter((p) => usa.includes(p.name))
  .map((p) => ({ name: p.name, body: p.body, header: p.header, header_text: p.header_text, footer: p.footer, buttons: p.buttons, ejemplos: p.ejemplos }));
for (const n of usa) if (!plantillas.some((p) => p.name === n)) console.error("aviso: falta la plantilla " + n);
const payload = { generado: d.generado, llave: d.llave, plantillas };
writeFileSync(salida, readFileSync(join(aca, "pagina.html"), "utf8").replace("/*__DATOS__*/null", JSON.stringify(payload).replace(/</g, "\\u003c")));
console.error(`ok: ${plantillas.length} plantillas → ${salida}`);
