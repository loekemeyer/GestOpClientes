// ¿Meta va a aceptar esta imagen? (supabase/functions/_shared/imagen-enviable.ts, Pablo Olejavetzky, 15/10/2026.) La foto del 599E (hd/599E.jpg) es un JPEG CMYK con un perfil ICC de
// 654 KB: Meta la acepta y después la rechaza (131053), las 2 veces que se mandó, y el bot había dicho «Le envié las fotos de los 10 peladores». Sin red: archivos armados a mano y un fetch falso.
// Correr: deno run --allow-env --allow-read tests/imagen-enviable.test.ts   (sale con código 1 si algo falla)
import { componentesJpeg, imagenEnviable, vaciarCacheImagenes, veredictoDeBytes } from "../supabase/functions/_shared/imagen-enviable.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

/** Un JPEG mínimo: SOI, JFIF, (un segmento APP2 de `icc` bytes, el perfil de color), SOF0 con N componentes, SOS, `cuerpo` bytes de datos y EOI. */
function jpeg(componentes: number, icc = 0, cuerpo = 0): Uint8Array {
  const partes: number[][] = [[0xff, 0xd8], [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]];
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * componentes, 8, 0x03, 0xe8, 0x03, 0xe8, componentes];
  for (let k = 0; k < componentes; k++) sof.push(k + 1, 0x11, 0);
  const cola = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9];
  const largoIcc = icc + 2;
  const app2 = icc ? [[0xff, 0xe2, (largoIcc >> 8) & 255, largoIcc & 255]] : [];
  const total = partes.reduce((n, p) => n + p.length, 0) + app2.reduce((n, p) => n + p.length, 0) + icc + sof.length + cola.length + cuerpo;
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of [...partes, ...app2]) { out.set(p, i); i += p.length; }
  i += icc;                       // el perfil: ceros
  out.set(sof, i); i += sof.length;
  out.set(cola.slice(0, cola.length - 2), i); i += cola.length - 2 + cuerpo;   // cabecera del SOS y datos (ceros)
  out.set([0xff, 0xd9], i);
  return out;
}
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

// ── Los bytes ──
igual("JPEG RGB: 3 componentes", componentesJpeg(jpeg(3)), 3);
igual("JPEG en grises: 1 componente", componentesJpeg(jpeg(1)), 1);
igual("JPEG CMYK: 4 componentes", componentesJpeg(jpeg(4)), 4);
igual("JPEG CMYK con perfil ICC de 654 KB: el SOF está después del perfil y se encuentra igual", componentesJpeg(jpeg(4, 654_000)), 4);
igual("JPEG cortado antes del SOF: todavía no se sabe", componentesJpeg(jpeg(3, 654_000).slice(0, 5_000)), undefined);
igual("JPEG con el SOF a medias: todavía no se sabe", componentesJpeg(jpeg(3).slice(0, 18 + 2 + 6)), undefined);
igual("no es un JPEG", componentesJpeg(png), null);
igual("JPEG RGB: se manda", veredictoDeBytes(jpeg(3)), { ok: true });
igual("JPEG en grises: se manda", veredictoDeBytes(jpeg(1)), { ok: true });
igual("PNG: se manda", veredictoDeBytes(png), { ok: true });
igual("JPEG CMYK: no se manda y dice por qué", veredictoDeBytes(jpeg(4)), { ok: false, motivo: "es un JPEG en CMYK: WhatsApp sólo acepta RGB o escala de grises" });
igual("WebP de verdad: no se manda", veredictoDeBytes(webp)?.ok, false);
igual("muy poco para saber: sigue leyendo", veredictoDeBytes(Uint8Array.from([0x52, 0x49, 0x46])), undefined);

// ── El fetch (falso): en streaming, cortando apenas se sabe ──
function respuesta(bytes: Uint8Array, trozo = 16_384, estado = 200) {
  const estadoLectura = { leidos: 0, cancelado: false };
  let pos = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= bytes.length) { c.close(); return; }
      const t = bytes.slice(pos, pos + trozo); pos += t.length; estadoLectura.leidos += t.length; c.enqueue(t);
    },
    cancel() { estadoLectura.cancelado = true; },
  });
  return { res: new Response(body, { status: estado }), estadoLectura };
}
function fetchDe(archivos: Record<string, Uint8Array>, registro: string[] = [], lecturas: Record<string, { leidos: number; cancelado: boolean }> = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    registro.push(url);
    const f = archivos[url];
    if (!f) return Promise.resolve(new Response("no", { status: 404 }));
    const { res, estadoLectura } = respuesta(f);
    lecturas[url] = estadoLectura;
    return Promise.resolve(init?.signal?.aborted ? new Response(null, { status: 499 }) : res);
  }) as typeof fetch;
}

{
  vaciarCacheImagenes();
  const llamadas: string[] = [], lecturas: Record<string, { leidos: number; cancelado: boolean }> = {};
  const rgb = jpeg(3, 300_000, 400_000), cmyk = jpeg(4, 654_000, 300_000);
  const f = fetchDe({ "https://x/586.webp": rgb, "https://x/hd/599E.jpg": cmyk, "https://x/p.png": png, "https://x/real.webp": webp }, llamadas, lecturas);
  igual("foto RGB (aunque el archivo se llame .webp): se manda", await imagenEnviable("https://x/586.webp", { fetchFn: f }), { ok: true });
  igual("RGB con perfil grande: se mira el SOF y se corta, no se baja todo", [lecturas["https://x/586.webp"].cancelado, lecturas["https://x/586.webp"].leidos > 300_000, lecturas["https://x/586.webp"].leidos < rgb.length], [true, true, true]);
  const r = await imagenEnviable("https://x/hd/599E.jpg", { fetchFn: f });
  igual("la del 599E (CMYK con ICC de 654 KB): no se manda", [r.ok, /CMYK/.test(String(r.motivo))], [false, true]);
  igual("el CMYK se corta apenas se ve el SOF, no baja todo el archivo", [lecturas["https://x/hd/599E.jpg"].cancelado, lecturas["https://x/hd/599E.jpg"].leidos < cmyk.length], [true, true]);
  igual("PNG: se manda", (await imagenEnviable("https://x/p.png", { fetchFn: f })).ok, true);
  igual("WebP de verdad: no se manda", (await imagenEnviable("https://x/real.webp", { fetchFn: f })).ok, false);
  const antes = llamadas.length;
  await imagenEnviable("https://x/hd/599E.jpg", { fetchFn: f });
  await imagenEnviable("https://x/586.webp", { fetchFn: f });
  igual("el resultado se recuerda: no se vuelve a bajar", llamadas.length, antes);
}
{
  vaciarCacheImagenes();
  let reloj = 1_000, n = 0;
  const f = (() => { n++; return Promise.resolve(respuesta(jpeg(4)).res); }) as typeof fetch;
  await imagenEnviable("https://x/a.jpg", { fetchFn: f, ahora: () => reloj });
  reloj += 7 * 3600 * 1000;
  await imagenEnviable("https://x/a.jpg", { fetchFn: f, ahora: () => reloj });
  igual("a las 7 horas se vuelve a mirar (la foto pudo cambiar)", n, 2);
}
{
  vaciarCacheImagenes();
  igual("no existe (404): se manda como siempre", await imagenEnviable("https://x/nada.jpg", { fetchFn: fetchDe({}) }), { ok: true });
  let intentos = 0;
  const cae = (() => { intentos++; return Promise.reject(new Error("red caída")); }) as typeof fetch;
  igual("la red falla: se manda como siempre", await imagenEnviable("https://x/b.jpg", { fetchFn: cae }), { ok: true });
  await imagenEnviable("https://x/b.jpg", { fetchFn: cae });
  igual("si falló no se recuerda: se vuelve a intentar", intentos, 2);
  const colgado = ((_i: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abortado"))))) as typeof fetch;
  const t0 = Date.now();
  igual("se cuelga: a los 30 ms se rinde y se manda", await imagenEnviable("https://x/c.jpg", { fetchFn: colgado, timeoutMs: 30 }), { ok: true });
  igual("y no espera más que eso", Date.now() - t0 < 500, true);
}

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
