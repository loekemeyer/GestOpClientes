#!/usr/bin/env bash
# Corre TODAS las pruebas de tests/*.test.ts, una por una, y sale con 1 si falla alguna.
# Son pruebas locales: sin red, sin IA, US$ 0. El CI las corre antes de deployar las edge functions
# (.github/workflows/deploy-edge-functions.yml, job "pruebas"): si una falla, no se deploya nada.
#
# Uso: ./tests/correr-todas.sh            (necesita deno 2.x y node 22+)
#
# Cada archivo se corre con lo que dice su línea "Correr:": node si la prueba se escribió para node
# (`node --experimental-strip-types`), deno en el resto. A deno se le da red SÓLO a localhost:54321, la URL
# falsa que las pruebas le pasan a _shared/supabase.ts: así ninguna puede llegar a la base real ni a una API
# paga aunque el entorno tuviera una clave. faq-tests.sh no entra: necesita `supabase functions serve`.
set -u
cd "$(dirname "$0")/.."

total=0
fallas=()
for f in tests/*.test.ts; do
  total=$((total + 1))
  if grep -q "node --experimental-strip-types" "$f"; then
    salida=$(timeout 120 node --experimental-strip-types --no-warnings "$f" 2>&1)
  else
    salida=$(timeout 120 deno run --no-prompt --allow-env --allow-read --allow-net=localhost:54321 "$f" 2>&1)
  fi
  codigo=$?
  if [ "$codigo" -eq 0 ]; then
    echo "ok     $f ($(grep -c '^ok' <<<"$salida") chequeos)"
  else
    fallas+=("$f")
    echo "FALLA  $f (código $codigo)"
    # Sólo lo que no pasó: las líneas "ok" de un archivo largo tapan la que importa.
    grep -v '^ok' <<<"$salida" | tail -40 | sed 's/^/       /'
  fi
done

echo
if [ "${#fallas[@]}" -gt 0 ]; then
  echo "${#fallas[@]} de $total archivos con fallas:"
  printf '  %s\n' "${fallas[@]}"
  exit 1
fi
echo "Las $total pruebas pasaron."
