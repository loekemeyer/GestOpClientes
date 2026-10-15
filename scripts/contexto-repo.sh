#!/usr/bin/env bash
# contexto-repo.sh — Hook de SessionStart.
#
# Claude NO tiene memoria entre conversaciones: cada charla arranca en cero y lo único que
# comparten todas las charlas de este repo es lo que quedó ESCRITO (git + docs/). Este hook
# imprime, al abrir cada charla, lo último anotado en docs/DECISIONES.md y docs/ESTADO.md y los
# commits recientes, para que una charla arranque sabiendo lo que decidieron/hicieron las otras.
# Sólo lee archivos del repo: no usa credenciales ni toca la base.
#
# El otro lado (la escritura) es la regla de CLAUDE.md "las decisiones se anotan en el mismo
# turno": si una charla no anota, este hook no la puede mostrar. El candado es la disciplina.

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

echo "📓 CONTEXTO COMPARTIDO DEL REPO (Claude no recuerda entre charlas; esto es lo que quedó escrito)"
echo ""

echo "── Últimas decisiones (docs/DECISIONES.md) · leé la entrada ENTERA antes de tocar su tema ──"
if [ -f docs/DECISIONES.md ]; then
  grep -nE '^## D[0-9]' docs/DECISIONES.md 2>/dev/null | tail -12 | sed -E 's/^[0-9]+:## /  /' || echo "  (sin entradas Dnn)"
else
  echo "  (no existe docs/DECISIONES.md)"
fi
echo ""

echo "── docs/ESTADO.md · última actualización ──"
if [ -f docs/ESTADO.md ]; then
  head -12 docs/ESTADO.md | grep -iaE 'ltima actuali' 2>/dev/null | head -1 | sed -E 's/^> *//; s/^/  /' | cut -c1-160 || echo "  (sin marca de fecha)"
else
  echo "  (no existe docs/ESTADO.md)"
fi
echo ""

echo "── Últimos commits ──"
git log -8 --pretty=format:'  %h %ad %s' --date=format:'%d/%m %H:%M' 2>/dev/null || echo "  (sin git)"
echo ""
echo ""

echo "⚠ Antes de proponer algo sobre un tema ya hablado (facturas, remitos, llave de envío, saludos,"
echo "  modelos, teléfonos, whitelist): grep -i el tema en docs/DECISIONES.md y docs/ESTADO.md."
echo "  Y lo que se decida, anotalo en docs/DECISIONES.md en el MISMO turno (regla de CLAUDE.md)."
exit 0
