#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sandbox local del bot — camino FAQ (0 IA). Levanta el esquema + el seed REAL
# (extraído de sql/007, sin duplicarlo) + el matcher (sql/054) en una base de
# prueba y corre un smoke test. NUNCA toca producción.
#
# Uso:
#   ./local/bootstrap.sh                 # postgres:16 descartable en Docker (puerto 55432)
#   ./local/bootstrap.sh "<DB_URL>"      # aplica sobre esa base (ej. tu Supabase local:
#                                        #   postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#
# Requisitos: Docker (modo descartable) o psql (modo DB_URL).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/local/01-faq-schema.sql"
SEED_SRC="$ROOT/sql/007_wa_faq.sql"
SEED_TMP="$(mktemp)"
trap 'rm -f "$SEED_TMP"' EXIT

# El INSERT real vive en sql/007 (líneas 73-482). Lo extraemos en runtime para no
# duplicar el seed: sql/007 sigue siendo la única fuente de verdad.
sed -n '73,482p' "$SEED_SRC" > "$SEED_TMP"

SMOKE_SQL="
select t.q as pregunta, m.category, m.automation_level as nivel, round(m.match_score,3) as score,
       case when m.match_score >= 1 then 'MATCH' else 'sin match (->IA/registro)' end as resultado
from (values ('¿Como pago?'),('cuál es el mínimo de compra'),('no me llegó la factura'),
             ('cuando llega mi pedido'),('quiero hacer un pedido'),('necesito mi contraseña'),
             ('donde retiro'),('asdfqwer zzz nada')) t(q)
left join lateral (select * from wa_faq_match(t.q) order by match_score desc limit 1) m on true
order by score desc nulls last;"

if [ "${1:-}" != "" ]; then
  DB_URL="$1"
  echo "→ aplicando sobre: $DB_URL"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$SCHEMA"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$SEED_TMP"
  echo "→ smoke test:"; psql "$DB_URL" -P pager=off -c "$SMOKE_SQL"
else
  echo "→ Postgres descartable en Docker (contenedor: bot-sandbox, puerto 55432)"
  docker rm -f bot-sandbox >/dev/null 2>&1 || true
  docker run -d --name bot-sandbox -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16 >/dev/null
  echo -n "   esperando postgres"
  for i in $(seq 1 40); do
    [ "$(docker logs bot-sandbox 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
    echo -n "."; sleep 1
  done; echo " listo"
  docker exec -i bot-sandbox psql -U postgres -q -v ON_ERROR_STOP=1 < "$SCHEMA"
  docker exec -i bot-sandbox psql -U postgres -q -v ON_ERROR_STOP=1 < "$SEED_TMP"
  echo "→ smoke test:"; docker exec -i bot-sandbox psql -U postgres -P pager=off -c "$SMOKE_SQL"
  echo "   (conexión: postgresql://postgres:pw@127.0.0.1:55432/postgres · borrar: docker rm -f bot-sandbox)"
fi
echo "✅ Sandbox FAQ lista."
