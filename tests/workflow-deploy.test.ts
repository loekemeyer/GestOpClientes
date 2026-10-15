// Pruebas estáticas del workflow de deploy (.github/workflows/deploy-edge-functions.yml). Sin red, sin IA, sin base.
// Correr: deno run --allow-env --allow-read tests/workflow-deploy.test.ts   (sale con código 1 si algo falla)
//
// Problema 813 (15/10/2026): la base del diff era sólo github.event.before. Un push rojo (pruebas caídas, deploy sin correr)
// seguido de uno que no tocaba funciones dejaba el CI verde con producción desactualizada (f03f3b4, corridas 464 y 465).
// Estas pruebas sólo leen el texto del workflow: no pueden correr el script (el CI no da --allow-run), pero atrapan que
// alguien vuelva a la base vieja. El script se probó a mano con un `gh` falso en 7 escenarios (ver docs/ESTADO.md, 15/10).
const wf = Deno.readTextFileSync(new URL("../.github/workflows/deploy-edge-functions.yml", import.meta.url));

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const deploy = wf.slice(wf.indexOf("\n  deploy:"));
const detectar = deploy.slice(deploy.indexOf("- name: Detectar funciones a desplegar"), deploy.indexOf("- name: Deploy\n"));

igual("el job deploy puede leer las corridas anteriores (actions: read)", /permissions:[\s\S]*?\bactions:\s*read\b/.test(deploy.slice(0, deploy.indexOf("steps:"))), true);
igual("la base es el último push verde de main (event=push, status=success)", detectar.includes("event=push&status=success") && detectar.includes("branch=main"), true);
igual("un commit del último verde que no está en la historia de HEAD se ignora", detectar.includes('git merge-base --is-ancestor "$OK_SHA" HEAD'), true);
igual("con dos candidatas gana la más vieja (desplegar de más es inofensivo)", detectar.includes('git merge-base --is-ancestor "$OK_SHA" "$BEFORE"'), true);
igual("si la API falla cae a github.event.before y después a HEAD^ (no rompe el deploy)", [detectar.includes("|| true)"), detectar.includes('BASE="$BEFORE"'), detectar.includes('BASE="HEAD^"')], [true, true, true]);
igual("la lista manual y el before llegan por env, no interpolados en el script", [detectar.includes("MANUAL: ${{ github.event.inputs.funciones }}"), /run: \|[\s\S]*\$\{\{\s*github\.event\.(inputs|before)/.test(detectar)], [true, false]);
igual("el checkout trae la historia completa (hace falta para el diff)", /fetch-depth:\s*0/.test(deploy), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
