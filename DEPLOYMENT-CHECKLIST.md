# Pre-Deployment Checklist

## Testing Local ✅
- [ ] `npm run dev:test` inicia sin errores
- [ ] `npm run test:faq:local` pasa todos los tests (6/6)
- [ ] No hay errores en console.error
- [ ] Response times < 500ms por pregunta

## FAQs Verificados ✅
- [ ] FAQ #10 (Facturación) → solo respuesta AUTO
- [ ] FAQ #15 (Pagos) → datos Credicoop actualizados
- [ ] FAQ #21 (Mínimo) → montos $500k/$300k
- [ ] FAQ #11 (Precios) → redirección web
- [ ] Dashboard `/docs/faq-dashboard.html` sincronizado con BD

## Código ✅
- [ ] `matchFAQ()` en `claude.ts` devuelve respuestas correctas
- [ ] `detectIntent()` clasifica intents sin errores
- [ ] `conversationalReply()` genera respuestas coherentes
- [ ] No hay hardcoded secrets (API keys, tokens)
- [ ] Todos los logs usan console.error para errores

## Base de Datos ✅
- [ ] Migraciones aplicadas a Supabase (`TESTING.md` → `apply_migration`)
- [ ] Tablas `wa_faq`, `wa_conversations`, `bot_token_usage` existen
- [ ] RPC `wa_faq_match()` funciona correctamente
- [ ] RPC `wa_product_match()` retorna productos válidos

## Meta WhatsApp API ✅
- [ ] Webhook URL configurada en Meta App Dashboard
- [ ] Verify Token coincide entre Meta y env
- [ ] Números de test Meta provistos y activos
- [ ] ngrok expone puerto 54321 sin errores

## Monitoring ✅
- [ ] Logs de `wa_conversations` se escriben correctamente
- [ ] Logs de `bot_token_usage` registran tokens/costo
- [ ] Blacklist funciona si está habilitada
- [ ] Rate limit está configurado pero disabled en test

## Credenciales ✅
- [ ] ANTHROPIC_API_KEY está en Supabase secrets (no en .env)
- [ ] META_ACCESS_TOKEN en secrets (no en código)
- [ ] SUPABASE_SERVICE_ROLE_KEY protegida
- [ ] `.env.local` no está en git (`.gitignore`)

## Documentación ✅
- [ ] TESTING.md completo y actualizado
- [ ] TESTING-QUICK.md con pasos de 5 min
- [ ] Este DEPLOYMENT-CHECKLIST completado
- [ ] CLAUDE.md refleja estado actual del bot

---

## Ejecución (solo si pasaste todo arriba)

### 1. Deploy a Staging
```bash
# En Meta: cambiar webhook URL a staging
# Testear con números Meta
npm run dev
# Monitorear logs: npm run logs:webhook
```

### 2. Deploy a Producción
```bash
# Cuando staging esté 100% OK:
git push origin claude/mel-27-8-context-1iigm4
# Crear PR en main
# Merge cuando reviewer apruebe
```

### 3. Post-Deploy
```bash
# Verificar logs en vivo
npm run logs:webhook

# Spot-check: enviar mensaje de prueba
# Ver que aparezca en wa_conversations en ~1 seg

# Validar cost/tokens en bot_token_usage
SELECT SUM(estimated_cost_usd) FROM bot_token_usage 
WHERE created_at >= NOW() - INTERVAL '1 hour';
```

---

## Rollback (si algo falla)

```bash
# Revertir webhook a versión anterior
git revert <commit_hash>
git push origin main

# Verificar en Meta que URL antigua responde
# Limpiar blacklist/cache si es necesario
```

---

**Status**: Ready to test ✅
**Last updated**: 2026-08-27
**Branch**: `claude/mel-27-8-context-1iigm4`
