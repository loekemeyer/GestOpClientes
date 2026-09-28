// humor-reglas — detectores puros (sin imports) de cliente molesto y mensaje urgente.
// Los usan humor.ts (deriva al molesto) y alertas.ts (marca la alerta como urgente).

const RE_INSULTO = /\b(bolud\w*|pelotud\w*|forr[oa]s?|idiot\w*|imb[eé]cil\w*|in[uú]til(es)?|chant\w*|estaf\w*|ladr[oó]n\w*|garcas?|mierda|carajo|la puta|hdp|verg[uü]enza|me cago|chorr[oa]s?)\b/i;
const RE_QUEJA = /(desastre|p[eé]sim\w*|horrible|mal[ií]sim\w*|un asco|nunca m[aá]s|no (les )?compro m[aá]s|me (tienen|tiene) (harto|harta|podrid\w*|cansad\w*|re\s*\w+)|estoy (re\s*)?(harto|harta|podrid\w*|cansad\w*|caliente|enojad\w*|furios\w*|indignad\w*|molest\w*)|no puede ser|es una joda|qu[eé] joda|me est[aá]n (jodiendo|cargando|boludeando|tomando el pelo)|tomada de pelo|falta de respeto|nadie (me )?(responde|contesta|atiende)|no (me )?(responden|contestan|atienden)|siempre lo mismo|otra vez lo mismo|defensa del consumidor|abogad\w*|denuncia)/i;
const RE_URGENTE = /(urgent\w*|urgencia|ya mismo|hoy mismo|ahora mismo|lo antes posible|cuanto antes|para hoy|no (me )?(lleg[oó]|vino|trajeron)|falt(aron|[oó])\b|faltan? (\d+|una?|la|el|las|los) (caja|unidad|art|producto|mercader)|vino (roto|rota|mal|incomplet\w*|fallad\w*)|\broto\b|rota\b|equivocad\w*|me cobraron (de m[aá]s|mal|doble)|cobr\w* doble|reclamo|devoluci[oó]n)/i;

function grita(t: string): boolean {
  const letras = t.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  const mayus = letras.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length;
  const signos = (t.match(/[!?]/g) ?? []).length;
  return (letras.length >= 12 && mayus / letras.length >= 0.7 && signos >= 1) || signos >= 4;
}

export function estaMolesto(text: string): boolean {
  const t = text.trim();
  return RE_INSULTO.test(t) || RE_QUEJA.test(t) || grita(t);
}

export function esUrgente(text: string): boolean {
  return estaMolesto(text) || RE_URGENTE.test(text);
}

