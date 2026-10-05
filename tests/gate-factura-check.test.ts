// Pruebas del gate de lk_factura-check (supabase/functions/lk_factura-check/gate.ts). Lógica pura, sin red.
// Correr: deno run tests/gate-factura-check.test.ts   (sale con código 1 si algo falla)
import { decidirGate, esperadoPara, igualesConstante, modoDeGate } from "../supabase/functions/lk_factura-check/gate.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const S = "a".repeat(64);

// modoDeGate: sólo "1"/"on" y "log" cambian algo; todo lo demás (incluso basura o null) es apagado.
igual("modo: sin fila", modoDeGate(null), "off");
igual("modo: undefined", modoDeGate(undefined), "off");
igual("modo: '0'", modoDeGate("0"), "off");
igual("modo: ''", modoDeGate(""), "off");
igual("modo: basura", modoDeGate("quizas"), "off");
igual("modo: 'log'", modoDeGate("log"), "log");
igual("modo: ' LOG '", modoDeGate(" LOG "), "log");
igual("modo: '1'", modoDeGate("1"), "on");
igual("modo: 'on'", modoDeGate("ON"), "on");

// igualesConstante
igual("igual: mismos", igualesConstante(S, S), true);
igual("igual: distinto último carácter", igualesConstante(S, "a".repeat(63) + "b"), false);
igual("igual: distinta longitud", igualesConstante(S, S + "a"), false);
igual("igual: vacíos", igualesConstante("", ""), true);

// Apagado: pasa TODO, no registra (el deploy del código no puede cambiar nada).
igual("off: sin header", decidirGate("off", "", S), { pasa: true, registrar: false, motivo: "gate apagado" });
igual("off: header malo", decidirGate("off", "x", S), { pasa: true, registrar: false, motivo: "gate apagado" });
igual("off: sin secreto esperado", decidirGate("off", "", null), { pasa: true, registrar: false, motivo: "gate apagado" });

// Log: pasa siempre, registra lo que no trae secreto válido.
igual("log: válido", decidirGate("log", S, S), { pasa: true, registrar: false, motivo: "secreto válido" });
igual("log: sin header", decidirGate("log", "", S), { pasa: true, registrar: true, motivo: "sin x-lk-secret" });
igual("log: no coincide", decidirGate("log", "x".repeat(64), S), { pasa: true, registrar: true, motivo: "x-lk-secret no coincide" });
igual("log: esperado ilegible", decidirGate("log", S, null), { pasa: true, registrar: true, motivo: "no se pudo leer el secreto esperado" });

// On: rechaza lo que no trae secreto válido, y FALLA CERRADO si no se pudo leer el esperado.
igual("on: válido", decidirGate("on", S, S), { pasa: true, registrar: false, motivo: "secreto válido" });
igual("on: sin header", decidirGate("on", "", S), { pasa: false, registrar: true, motivo: "sin x-lk-secret" });
igual("on: no coincide", decidirGate("on", "x".repeat(64), S), { pasa: false, registrar: true, motivo: "x-lk-secret no coincide" });
igual("on: esperado ilegible (falla cerrada)", decidirGate("on", S, null), { pasa: false, registrar: true, motivo: "no se pudo leer el secreto esperado" });
igual("on: esperado vacío + header vacío NO pasa", decidirGate("on", "", ""), { pasa: false, registrar: true, motivo: "sin x-lk-secret" });

// esperadoPara: secret de la edge primero, Vault de respaldo. `llamadas` cuenta cuántas veces se tocó el Vault (Gestión).
async function caso(recibido: string, env: string, vault: string | null | "throw") {
  let llamadas = 0;
  const r = await esperadoPara(recibido, env, async () => {
    llamadas++;
    if (vault === "throw") throw new Error("Gestión no contesta");
    return vault;
  });
  return { ...r, llamadas };
}
const V = "v".repeat(64);
igual("esperadoPara: coincide con la edge → no toca el Vault", await caso(S, S, V), { esperado: S, origen: "env", llamadas: 0 });
igual("esperadoPara: edge sin secret → lee el Vault", await caso(V, "", V), { esperado: V, origen: "vault", llamadas: 1 });
igual("esperadoPara: rotación sólo en el Vault (edge con el viejo) → gana el Vault", await caso(V, S, V), { esperado: V, origen: "vault", llamadas: 1 });
igual("esperadoPara: Vault caído, edge con secret → compara contra la edge", await caso(S, S, "throw"), { esperado: S, origen: "env", llamadas: 0 });
igual("esperadoPara: Vault caído y recibido ≠ edge → esperado = edge (no coincide)", await caso("x".repeat(64), S, "throw"), { esperado: S, origen: "env (Vault ilegible)", llamadas: 1 });
igual("esperadoPara: Vault devuelve vacío → igual que caído", await caso("x".repeat(64), S, null), { esperado: S, origen: "env (Vault ilegible)", llamadas: 1 });
igual("esperadoPara: ni edge ni Vault → null (falla cerrada)", await caso(S, "", "throw"), { esperado: null, origen: "ninguno", llamadas: 1 });
igual("esperadoPara: sin header → no se lee el Vault", await caso("", S, V), { esperado: S, origen: "sin header", llamadas: 0 });
igual("esperadoPara: sin header y sin edge → null, no se lee el Vault", await caso("", "", V), { esperado: null, origen: "sin header", llamadas: 0 });

// De punta a punta con decidirGate (modo "on" = el que importa): lo legítimo pasa aunque Gestión esté caído.
{
  const { esperado } = await caso(S, S, "throw");
  igual("on + Vault caído + edge con secret + secreto bueno → PASA", decidirGate("on", S, esperado).pasa, true);
  const m = await caso("x".repeat(64), S, "throw");
  igual("on + Vault caído + secreto malo → RECHAZA", decidirGate("on", "x".repeat(64), m.esperado).pasa, false);
  const n = await caso(S, "", "throw");
  igual("on + Vault caído + edge SIN secret → RECHAZA (falla cerrada)", decidirGate("on", S, n.esperado).pasa, false);
  const r = await caso(V, S, V);
  igual("on + rotación sólo en el Vault → PASA con el secreto nuevo", decidirGate("on", V, r.esperado).pasa, true);
}

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
