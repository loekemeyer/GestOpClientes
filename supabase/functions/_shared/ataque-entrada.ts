// Señal de ataque en la ENTRADA (Pablo Olejavetzky, 13/10/2026 — riesgo 4 del anexo de la constitución).
//
// Detecta, en el texto del cliente, patrones de ALTA PRECISIÓN de inyección / extracción de prompt / jailbreak.
// NO es una barrera y NO corta la respuesta: la defensa real es el bloque de Seguridad del prompt, el canario y
// el filtro de salida. Esto es sólo una señal que escala: el webhook cuenta los intentos por número en 24 h
// (RPC bot_ataque_entrada, sql/143) y a los 3 avisa a una persona, a los 5 manda el número a wa_blacklist.
//
// Precisión antes que cobertura: un falso positivo bloquearía a un cliente real, así que los patrones son
// específicos y la pregunta legítima "¿sos un bot / robot / persona?" NO matchea ninguno (está permitida).
// Un atacante que parafrasea pasa igual: lo frena la Seguridad, no esto. Módulo PURO: tests/ataque-entrada.test.ts.

export interface DeteccionAtaque {
  hit: boolean;
  /** Etiqueta corta del patrón (para la alerta y el log); nunca el texto del cliente. */
  patron?: string;
}

// Ojo con \b: en JavaScript es ASCII. Después de una letra con tilde («Ignorá», «Olvidá», «Mostrá», «decí») NO hay límite de palabra, y antes de una palabra que
// empieza con tilde («órden») tampoco. Por eso esos bordes usan (?![a-záéíóúüñ]) y (?<![a-záéíóúüñ]). Sin eso, el voseo con tilde no se detectaba (13/10, tests/ataque-entrada.test.ts).
const PATRONES: { etiqueta: string; re: RegExp }[] = [
  { etiqueta: "ignorar_instrucciones", re: /\bignor[aá](?:r|lo|las|los)?(?![a-záéíóúüñ])[^.?!]{0,25}(?<![a-záéíóúüñ])(instruccion|regla|[oó]rden|lo anterior|todo lo que)/i },
  { etiqueta: "olvidar_reglas", re: /\bolvid[aá](?:te|lo)?(?![a-záéíóúüñ])[^.?!]{0,25}(?<![a-záéíóúüñ])(instruccion|regla|[oó]rden)/i },
  { etiqueta: "ignore_instructions_en", re: /\bignore\b[^.?!]{0,25}\b(instruction|rule|prompt|previous)/i },
  { etiqueta: "modo_desarrollador", re: /\bmodo\s+desarrollador\b|\bdeveloper\s+mode\b/i },
  { etiqueta: "jailbreak", re: /\bjailbreak\b|\bmodo\s+dan\b|\bdan\s+mode\b/i },
  { etiqueta: "extraer_prompt", re: /\b(system\s+prompt|prompt\s+del\s+sistema|tus\s+instrucciones|reglas?\s+internas?|tu\s+configuraci[oó]n\s+interna)\b/i },
  { etiqueta: "pedir_prompt", re: /\b(mostr[aá]|dec[ií]|repet[ií]|dame|revel[aá]|cu[aá]l\s+es)(?![a-záéíóúüñ])[^.?!]{0,30}\b(prompt|instruccion|reglas?\s+internas?)\b/i },
  { etiqueta: "actuar_como", re: /\b(actu[aá]\s+como|comport[aá]te\s+como|pretend\s+to\s+be|act\s+as\s+if)\b/i },
  { etiqueta: "sin_restricciones", re: /\bsin\s+(restriccion|reglas?|filtro|l[ií]mite|censura)/i },
  { etiqueta: "base64_largo", re: /[A-Za-z0-9+/]{40,}={0,2}/ },
];

/** ¿El texto del cliente parece un intento de ataque de prompt? Alta precisión: ante la duda, NO. */
export function pareceAtaqueEntrada(texto: string): DeteccionAtaque {
  const t = String(texto ?? "");
  if (!t.trim()) return { hit: false };
  for (const p of PATRONES) if (p.re.test(t)) return { hit: true, patron: p.etiqueta };
  return { hit: false };
}

// Umbrales (deben coincidir con bot_ataque_entrada en sql/143). Acá sólo para el test y la documentación.
export const ATAQUE_ALERTA = 3;
export const ATAQUE_BLACKLIST = 5;
