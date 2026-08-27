#!/bin/bash
# Testing script para FAQs del bot — ejecutar después de `supabase functions serve`
# Uso: ./tests/faq-tests.sh [base_url] [phone]
# Ej: ./tests/faq-tests.sh "http://localhost:54321/functions/v1/lk_chat-test" "1166574113"

BASE_URL="${1:-http://localhost:54321/functions/v1/lk_chat-test}"
PHONE="${2:-1166574113}"
PASSED=0
FAILED=0

echo "🤖 FAQ Testing — BotWA-LK"
echo "URL: $BASE_URL"
echo "Phone: $PHONE"
echo "---"

test_faq() {
  local id=$1
  local query=$2
  local expected_keyword=$3

  echo -n "FAQ #$id: \"$query\" ... "

  response=$(curl -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"$PHONE\",\"text\":\"$query\",\"noAI\":true}" 2>/dev/null)

  reply=$(echo "$response" | jq -r '.reply // "ERROR"' 2>/dev/null)
  faq_hit=$(echo "$response" | jq -r '.faqHit // false' 2>/dev/null)

  if [[ "$faq_hit" == "true" ]] && [[ "$reply" == *"$expected_keyword"* ]]; then
    echo "✅ PASS"
    ((PASSED++))
  else
    echo "❌ FAIL"
    echo "  Got: $reply"
    ((FAILED++))
  fi
}

# FAQ Tests
echo "📋 AUTO FAQs (0 tokens)"
test_faq 10 "¿Donde está mi factura?" "factura se envía"
test_faq 10 "no llegó factura" "pasame tu CUIT"
test_faq 15 "¿Como pago?" "medios de pago"
test_faq 15 "transferencia bancaria" "Credicoop"
test_faq 15 "¿Tienen cuotas?" "descuento"
test_faq 21 "¿Cual es el mínimo?" "\$500"
test_faq 21 "mínimo de compra" "300"

echo ""
echo "📊 Results: $PASSED passed, $FAILED failed"

if [ $FAILED -eq 0 ]; then
  echo "🎉 All tests passed!"
  exit 0
else
  echo "⚠️ Some tests failed. Check responses above."
  exit 1
fi
