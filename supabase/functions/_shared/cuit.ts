// CUIT: validación y extracción de un texto. Sin dependencias (lo usan alta.ts y constancia.ts; antes vivía en alta.ts y
// constancia.ts no podía importarlo sin un import circular). alta.ts los re-exporta: el resto del código no cambia.

export function validaCuit(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cuit[i]) * mult[i];
  const mod = 11 - (sum % 11);
  const dv = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return dv === Number(cuit[10]);
}

/**
 * Extrae un CUIT válido del texto, independiente del formato que use el
 * cliente ("20-12345678-9", "20/12345678/9", "cuit20123456789", "cuit: 20
 * 12345678 9", etc.). Se limpian TODOS los no-dígitos y se recorren ventanas
 * de 11 dígitos exigiendo dígito verificador (módulo 11) correcto — evita
 * falsos positivos con teléfonos de 10-11 dígitos o CUITs mal tipeados.
 */
export function extractCuit(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 11) return null;
  // Ventana móvil de 11 dígitos: el primer candidato que pase módulo 11 gana.
  for (let i = 0; i + 11 <= digits.length; i++) {
    const cand = digits.slice(i, i + 11);
    if (validaCuit(cand)) return cand;
  }
  return null;
}

/** "30712345678" -> "30-71234567-8" */
export function formatoCuit(cuit: string): string {
  return /^\d{11}$/.test(cuit) ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;
}
