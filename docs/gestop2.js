// GestOp · rediseño (Claude Design, 28/09) — etapa 1 (menú por módulos, header con pestañas, franja de la
// llave, modo oscuro) y etapa 2 (Centro de mensajes › Conversaciones). Se carga DESPUÉS del script de
// index.html y se engancha a sus funciones (showPage, showConfigTab, showAgenteTab, authedInvoke…).
/* global authedInvoke, currentRole, currentEmail, sb, showConfigTab, showAgenteTab, switchChatTab, esc, loadAlertas, pintarBadgeAlertas */

var G = {
  mod: "com", sec: "conv", abiertos: { com: true },
  esperando: 0, alertas: 0, vinculos: 0, consultas: 0,
  llave: null, miNombre: null,
  slDias: 7, tareas: [], tareaSel: null, filtroTipo: "todas", resueltasHoy: 0,
  convs: [], convSel: null, hilo: null, ficha: null, filtroEstado: "todas", filtroTema: "", filtroEspera: 0, buscar: "",
};
const esAdmin = () => currentRole === "admin";
const gesc = (s) => (typeof esc === "function" ? esc(String(s ?? "")) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

// ── Módulos y secciones (mismo orden que el diseño) ─────────────────────────
const MODULOS = [
  { id: "com", nombre: "Comunicaciones", titulo: "Centro de mensajes", secciones: [
    { id: "conv", nombre: "Conversaciones", admin: true, badge: () => G.esperando, abrir: () => irPagina("conv") },
    { id: "tareas", nombre: "Tareas", admin: true, badge: () => G.alertas + G.vinculos, abrir: () => irPagina("tareas") },
    { id: "salientes", nombre: "Salientes", admin: true, abrir: () => irPagina("salientes") },
    { id: "pruebas", nombre: "Pruebas", abrir: () => { irPagina("chat"); switchChatTab("testChat"); } },
  ] },
  { id: "dash", nombre: "Dashboard", secciones: [
    { id: "pipe", nombre: "Pipeline de facturas", abrir: () => { irPagina("dash"); abrirDash(0); } },
    { id: "ia", nombre: "IA · gastos y uso", abrir: () => { irPagina("dash"); abrirDash(1); } },
  ] },
  { id: "cfg", nombre: "Panel de Control", secciones: [
    { id: "acceso", nombre: "Acceso", abrir: () => cfg("acceso") },
    { id: "limite", nombre: "Rate limit", abrir: () => cfg("limite") },
    { id: "pagos", nombre: "Descuentos", abrir: () => cfg("pagos") },
    { id: "plantillas", nombre: "Plantillas", abrir: () => cfg("plantillas") },
    { id: "vinculos", nombre: "Vinculaciones", badge: () => G.vinculos, abrir: () => cfg("vinculos") },
  ] },
  { id: "ag", nombre: "Configuración del agente", admin: true, secciones: [
    { id: "fijas", nombre: "Reglas fijas", abrir: () => ag("fijas") },
    { id: "objetivo", nombre: "Objetivo", abrir: () => ag("objetivo") },
    { id: "limites", nombre: "Limitaciones y Permisos", abrir: () => ag("limites") },
    { id: "faq", nombre: "Preguntas frecuentes", abrir: () => ag("faq") },
    { id: "consultas", nombre: "Consultas", badge: () => G.consultas, abrir: () => ag("consultas") },
    { id: "eval", nombre: "Evaluación", abrir: () => ag("eval") },
    { id: "modelos", nombre: "Modelos", abrir: () => ag("modelos") },
  ] },
];
function cfg(tab) { irPagina("config"); showConfigTab(tab); }
function ag(tab) { irPagina("agente"); showAgenteTab(tab); }
function abrirDash(i) {
  const ds = document.querySelectorAll("#pageDash details.dash-section");
  ds.forEach((d, j) => { d.open = j === i; });
  if (ds[i]) ds[i].scrollIntoView({ block: "start" });
}
const visibles = (m) => m.secciones.filter((s) => !s.admin || esAdmin());

// Página → módulo/sección, así el menú queda sincronizado aunque otra función llame a showPage().
const PAGINA_A = { conv: ["com", "conv"], tareas: ["com", "tareas"], salientes: ["com", "salientes"], alertas: ["com", "tareas"], chat: ["com", "pruebas"], dash: ["dash", null], config: ["cfg", null], agente: ["ag", null] };

// ── showPage extendido: suma la página nueva del Centro de mensajes ─────────
const _showPageViejo = showPage;
function irPagina(p) {
  const nueva = p === "conv" || p === "tareas" || p === "salientes";
  _showPageViejo(nueva ? "__ninguna__" : p);
  document.getElementById("pageConv").classList.toggle("active", p === "conv");
  document.getElementById("pageTareas")?.classList.toggle("active", p === "tareas");
  document.getElementById("pageSalientes")?.classList.toggle("active", p === "salientes");
  const [m, s] = PAGINA_A[p] || [G.mod, G.sec];
  G.mod = m;
  if (s) G.sec = s;
  G.abiertos[m] = true;
  if (p === "conv") cmCargar();
  if (p === "tareas") tkCargar();
  if (p === "salientes") slCargar();
  renderNav();
}
// eslint-disable-next-line no-global-assign
showPage = irPagina;
const _cfgViejo = showConfigTab;
// eslint-disable-next-line no-global-assign
showConfigTab = function (t) { _cfgViejo(t); G.mod = "cfg"; G.sec = t; renderNav(); };
const _agViejo = showAgenteTab;
// eslint-disable-next-line no-global-assign
showAgenteTab = function (t) { _agViejo(t); G.mod = "ag"; G.sec = t; renderNav(); };

function renderNav() {
  const mods = MODULOS.filter((m) => !m.admin || esAdmin());
  // Sidebar
  const box = document.getElementById("sbModulos");
  if (box) {
    box.innerHTML = mods.map((m) => {
      const abierto = !!G.abiertos[m.id];
      const actual = G.mod === m.id;
      const pend = visibles(m).reduce((n, s) => n + (s.badge ? Number(s.badge()) || 0 : 0), 0);
      const secs = abierto ? `<div class="sb-secs">${visibles(m).map((s) => {
        const b = s.badge ? Number(s.badge()) || 0 : 0;
        return `<button class="sb-sec${actual && G.sec === s.id ? " activa" : ""}" onclick="navSec('${m.id}','${s.id}')">${gesc(s.nombre)}${b ? `<span class="g-badge">${b}</span>` : ""}</button>`;
      }).join("")}</div>` : "";
      return `<div><button class="sb-mod${abierto ? "" : " cerrado"}${actual && !abierto ? " cerrado-actual" : ""}" onclick="navMod('${m.id}')">${gesc(m.nombre)}${!abierto && pend ? `<span class="g-badge">${pend}</span>` : ""}<span class="flecha">▼</span></button>${secs}</div>`;
    }).join("");
  }
  // Header
  const m = MODULOS.find((x) => x.id === G.mod) || MODULOS[0];
  const tit = document.getElementById("modTitulo");
  if (tit) tit.textContent = m.titulo || m.nombre;
  const tabs = document.getElementById("modTabs");
  if (tabs) {
    tabs.innerHTML = visibles(m).map((s) => {
      const b = s.badge ? Number(s.badge()) || 0 : 0;
      return `<button class="mod-tab${G.sec === s.id ? " activa" : ""}" onclick="navSec('${m.id}','${s.id}')">${gesc(s.nombre)}${b ? `<span class="g-badge">${b}</span>` : ""}</button>`;
    }).join("");
  }
  const sel = document.getElementById("modSelect");
  if (sel) {
    sel.innerHTML = mods.map((x) => `<option value="${x.id}"${x.id === G.mod ? " selected" : ""}>${gesc(x.nombre.toUpperCase())}</option>`).join("");
  }
}
function navMod(id) {
  if (G.mod === id) { G.abiertos[id] = !G.abiertos[id]; renderNav(); return; }
  G.abiertos[id] = true;
  const m = MODULOS.find((x) => x.id === id);
  const s = visibles(m)[0];
  if (s) { G.mod = id; G.sec = s.id; s.abrir(); }
  renderNav();
}
function navSec(mid, sid) {
  const m = MODULOS.find((x) => x.id === mid);
  const s = m && m.secciones.find((x) => x.id === sid);
  if (!s) return;
  G.mod = mid; G.sec = sid;
  s.abrir();
  renderNav();
}

// ── Modo oscuro ─────────────────────────────────────────────────────────────
function aplicarTema(oscuro) {
  document.documentElement.classList.toggle("dark", oscuro);
  const b = document.getElementById("btnTema");
  if (b) b.textContent = oscuro ? "Modo claro" : "Modo oscuro";
  try { localStorage.setItem("gestop_tema", oscuro ? "oscuro" : "claro"); } catch { /* sin storage */ }
}
function cambiarTema() { aplicarTema(!document.documentElement.classList.contains("dark")); }
try { aplicarTema(localStorage.getItem("gestop_tema") === "oscuro"); } catch { /* sin storage */ }

// ── Toast y modal ───────────────────────────────────────────────────────────
function toast(t) {
  const d = document.createElement("div");
  d.className = "g-toast"; d.textContent = t;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}
function modal(html) {
  cerrarModal();
  const f = document.createElement("div");
  f.className = "g-modal-fondo"; f.id = "gModal";
  f.innerHTML = `<div class="g-modal" role="dialog">${html}</div>`;
  f.addEventListener("click", (e) => { if (e.target === f) cerrarModal(); });
  document.body.appendChild(f);
  return f;
}
function cerrarModal() { document.getElementById("gModal")?.remove(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarModal(); });

async function conv(body) {
  const { data, error } = await authedInvoke("lk_conversaciones", body);
  if (error) {
    // supabase-js esconde el cuerpo en error.context: mostrar el motivo real (ej. login caído).
    let msg = error.message || "error";
    try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) { /* sin cuerpo */ }
    throw new Error(msg);
  }
  if (data && data.error) { const e = new Error(data.note || data.error); throw e; }
  return data;
}

// ── Franja de la llave de envíos (siempre visible) ─────────────────────────
const LLAVE = {
  "0": { nombre: "APAGADO", clase: "m-0", desc: "No sale ningún mensaje: ni respuestas del bot, ni avisos, ni respuestas humanas." },
  prueba: { nombre: "PRUEBA", clase: "m-prueba", desc: "Sólo salen mensajes a los números de prueba. Lo que va a clientes queda retenido." },
  "1": { nombre: "PRODUCCIÓN", clase: "m-1", desc: "Los mensajes salen a los clientes." },
};
async function cargarLlave() {
  if (!esAdmin()) return;
  try {
    G.llave = await conv({ action: "llave_get" });
    pintarLlave();
  } catch (e) { console.warn("llave:", e.message); }
}
function pintarLlave() {
  const el = document.getElementById("llaveBand");
  const l = G.llave;
  if (!el || !l) return;
  const m = LLAVE[l.modo] || LLAVE["0"];
  const desc = l.modo === "prueba" ? `Sólo salen mensajes ${l.contactos_prueba === 1 ? "al número" : `a los ${l.contactos_prueba} números`} de prueba. Lo que va a clientes queda retenido.` : m.desc;
  el.className = "llave-band " + m.clase;
  el.innerHTML = `<span class="lk-k">Envíos a clientes</span><span class="lk-modo">${m.nombre}</span><span class="lk-desc">${gesc(desc)}</span>
    <span class="lk-hoy">Hoy: ${l.hoy.enviados} enviados · ${l.hoy.fallidos} fallidos · ${l.hoy.retenidos} retenidos</span>
    ${esAdmin() ? `<button onclick="modalLlave()">Cambiar modo…</button>` : ""}`;
  el.style.display = "flex";
}
var _llaveElegida = null;
function modalLlave() {
  const l = G.llave;
  if (!l) return;
  _llaveElegida = l.modo;
  const ult = l.ultimo_cambio
    ? `último cambio ${new Date(l.ultimo_cambio.creado_en).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} por ${gesc(l.ultimo_cambio.usuario)}`
    : "sin cambios registrados desde el panel";
  modal(`<h3>Cambiar la llave de envíos</h3>
    <div style="font-size:12px;color:var(--g-muted)">Modo actual: <b style="color:var(--ink)">${LLAVE[l.modo]?.nombre || l.modo}</b> · ${ult}</div>
    <div id="lkOpciones" style="display:flex;flex-direction:column;gap:8px"></div>
    <div id="lkExtra"></div>
    ${l.auditoria ? "" : `<div class="nota aviso-ambar">Falta crear el registro de cambios (sql/080). Hasta entonces no se puede cambiar desde acá.</div>`}
    <div class="botones"><button class="g-btn" onclick="cerrarModal()">Cancelar</button><button class="g-btn prim" id="lkOk" onclick="confirmarLlave()">Elegí otro modo</button></div>`);
  pintarOpcionesLlave();
}
function pintarOpcionesLlave() {
  const l = G.llave;
  const col = { "0": "#4a4a4d;color:#f1ead8", prueba: "#e2b13c;color:#212122", "1": "#2f5a37;color:#f1ead8" };
  document.getElementById("lkOpciones").innerHTML = ["0", "prueba", "1"].map((k) =>
    `<button class="opcion${_llaveElegida === k ? " elegida" : ""}" onclick="_llaveElegida='${k}';pintarOpcionesLlave()">
      <span class="caja" style="background:${col[k]}">${LLAVE[k].nombre}</span><span>${gesc(k === "prueba" ? `Sólo salen mensajes ${l.contactos_prueba === 1 ? "al número" : `a los ${l.contactos_prueba} números`} de prueba. Lo que va a clientes queda retenido.` : LLAVE[k].desc)}${k === l.modo ? " <b>(actual)</b>" : ""}</span></button>`).join("");
  const extra = document.getElementById("lkExtra");
  const ok = document.getElementById("lkOk");
  if (_llaveElegida === "1" && l.modo !== "1") {
    extra.innerHTML = `<div class="nota" style="background:var(--wait-bg);color:var(--wait-fg)">Desde que confirmes, los avisos y las respuestas salen a los clientes reales.</div>
      <label style="font-size:12px;display:flex;flex-direction:column;gap:4px">Para confirmar, escribí PRODUCCIÓN<input type="text" id="lkConf" oninput="validarLlave()" autocomplete="off"></label>`;
  } else if (_llaveElegida === "0" && l.modo !== "0") {
    extra.innerHTML = `<div class="nota aviso-ambar">No va a salir ningún mensaje: ni avisos de pedidos, ni respuestas del bot, ni respuestas de personas.</div>`;
  } else extra.innerHTML = "";
  ok.textContent = _llaveElegida === l.modo ? "Elegí otro modo" : `Cambiar a ${LLAVE[_llaveElegida].nombre}`;
  validarLlave();
}
function validarLlave() {
  const l = G.llave, ok = document.getElementById("lkOk");
  let valido = _llaveElegida !== l.modo && l.auditoria;
  if (valido && _llaveElegida === "1") {
    const t = (document.getElementById("lkConf")?.value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
    valido = t === "PRODUCCION";
  }
  ok.disabled = !valido;
}
async function confirmarLlave() {
  const ok = document.getElementById("lkOk");
  ok.disabled = true; ok.textContent = "Cambiando…";
  try {
    G.llave = await conv({ action: "llave_set", modo: _llaveElegida, confirmacion: document.getElementById("lkConf")?.value || "" });
    cerrarModal(); pintarLlave();
    toast(`La llave quedó en ${LLAVE[G.llave.modo].nombre}.`);
  } catch (e) { ok.textContent = "Reintentar"; ok.disabled = false; toast("No se pudo cambiar: " + e.message); }
}

// ── Centro de mensajes › Conversaciones ─────────────────────────────────────
const ESTADO_TXT = { esperando: "Esperando humano", humano: "Humano", bot: "Bot", resuelta: "Resuelta" };
const RANGO = { esperando: 0, humano: 1, bot: 2, resuelta: 3 };
const minDesde = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : 0);
function dur(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return h < 48 ? `${h} h${r ? ` ${r} min` : ""}` : `${Math.round(h / 24)} días`;
}
const edad = (min) => (min >= 120 ? "edad-2" : min >= 30 ? "edad-1" : "edad-0");
const hora = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
// dd/mm en hora argentina (armado a mano: toLocaleDateString no siempre respeta el 2-digit).
const fechaCorta = (iso) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  return `${p.slice(8, 10)}/${p.slice(5, 7)}`;
};
// Minutos sin responder: desde la derivación sin atender o desde el último mensaje del cliente sin contestar.
function sinResponder(c) {
  if (c.estado_ui === "resuelta") return 0;
  if (c.estado_ui === "esperando" && c.espera_desde) return minDesde(c.espera_desde);
  if (c.last_dir === "in") return minDesde(c.last_at);
  return 0;
}
// Para ORDENAR la bandeja sólo cuenta la espera reciente (ventana de 24 h de WhatsApp, con margen: 48 h). Un mensaje
// sin contestar de hace meses (ej. el "Sí, descargar" del 04/05, botón de una plantilla vieja) quedaba primero de todo
// por tener la espera más larga (Pablo, 29/09). El filtro "Sin responder" sigue usando sinResponder().
function esperaParaOrden(c) {
  const m = sinResponder(c);
  return c.estado_ui === "esperando" || m <= 48 * 60 ? m : 0;
}
function nombreConv(c) { return c.business_name || null; }
const humanizar = (s) => { const t = String(s || "").replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
function textoUltimo(c) {
  const b = String(c.last_body || "");
  const av = b.match(/^\[Aviso automático (\S+)[^\]]*\]\n?([\s\S]*)$/) || b.match(/^\[Plantilla: (\S+)\]\s*([\s\S]*)$/);
  if (av) return "Aviso: " + (av[2] || humanizar(av[1]));
  return (c.last_dir === "out" ? "Bot: " : "") + b;
}

async function cmCargar() {
  if (!esAdmin()) return;
  try {
    const d = await conv({ action: "list" });
    G.convs = d.items || [];
    G.esperando = G.convs.filter((c) => c.estado_ui === "esperando").length;
    cmPintarBandeja();
    renderNav();
  } catch (e) {
    document.getElementById("cmLista").innerHTML = `<div class="cm-vacio">No se pudo cargar: ${gesc(e.message)}</div>`;
  }
}
function cmFiltradas() {
  const q = G.buscar.trim().toLowerCase();
  return G.convs.filter((c) => {
    if (G.filtroEstado !== "todas" && c.estado_ui !== G.filtroEstado) return false;
    if (G.filtroTema && c.tema !== G.filtroTema) return false;
    if (G.filtroEspera && sinResponder(c) < G.filtroEspera) return false;
    if (q && !`${c.business_name || ""} ${c.cod_cliente || ""} ${c.phone}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (RANGO[a.estado_ui] - RANGO[b.estado_ui]) || (esperaParaOrden(b) - esperaParaOrden(a)) || String(b.last_at).localeCompare(String(a.last_at)));
}
function cmPintarBandeja() {
  const esp = G.convs.filter((c) => c.estado_ui === "esperando");
  const vieja = esp.reduce((m, c) => Math.max(m, sinResponder(c)), 0);
  const prio = document.getElementById("cmPrio");
  prio.className = "cm-prio" + (esp.length ? "" : " cero");
  prio.innerHTML = esp.length ? `<b>${esp.length}</b> esperando humano<span class="v">la más vieja: ${dur(vieja)}</span>` : `<b>0</b> esperando humano<span class="v">al día</span>`;
  const cuenta = (e) => G.convs.filter((c) => e === "todas" || c.estado_ui === e).length;
  document.getElementById("cmChips").innerHTML = ["todas", "esperando", "humano", "bot", "resuelta"].map((e) =>
    `<button class="cm-chip${G.filtroEstado === e ? " activo" : ""}" onclick="G.filtroEstado='${e}';cmPintarBandeja()">${e === "todas" ? "Todas" : ESTADO_TXT[e]} · ${cuenta(e)}</button>`).join("");
  const temas = [...new Set(G.convs.map((c) => c.tema).filter(Boolean))];
  const selT = document.getElementById("cmTema");
  selT.innerHTML = `<option value="">Tema: todos</option>` + temas.map((t) => `<option${t === G.filtroTema ? " selected" : ""}>${gesc(t)}</option>`).join("");
  const lista = cmFiltradas();
  const listaEl = document.getElementById("cmLista"), listaScroll = listaEl.scrollTop;
  requestAnimationFrame(() => { listaEl.scrollTop = listaScroll; });   // el refresco no la manda arriba
  listaEl.innerHTML = lista.length ? lista.map((c) => {
    const min = sinResponder(c);
    const n = nombreConv(c);
    const meta = [c.cod_cliente ? `Cód. ${c.cod_cliente}` : `+${c.phone}`, c.tema, c.agente && c.estado_ui === "humano" ? `→ ${c.agente}` : c.tomada_por ? `→ ${c.tomada_por}` : null].filter(Boolean).join(" · ");
    return `<div class="cm-fila${G.convSel === c.phone ? " sel" : ""}" onclick="cmAbrir('${gesc(c.phone)}')">
      <div class="l1">${n ? `<b>${gesc(n)}</b>` : `<i>No identificado</i>`}<span>${c.last_at ? (fechaCorta(c.last_at) === fechaCorta(new Date().toISOString()) ? hora(c.last_at) : fechaCorta(c.last_at)) : ""}</span></div>
      <div class="l2">${gesc(textoUltimo(c))}</div>
      <div class="l3"><span class="est ${c.estado_ui}">${ESTADO_TXT[c.estado_ui]}</span>${min ? `<span class="${edad(min)}">hace ${dur(min)}</span>` : ""}<span class="meta">${gesc(meta)}</span><span class="canal">WA</span></div>
    </div>`;
  }).join("") : `<div class="cm-vacio">No hay conversaciones con ese filtro.</div>`;
}
function cmPrioClick() { G.filtroEstado = "esperando"; G.filtroTema = ""; G.filtroEspera = 0; G.buscar = ""; document.getElementById("cmBuscar").value = ""; document.getElementById("cmEspera").value = "0"; cmPintarBandeja(); }

async function cmAbrir(phone) {
  G.convSel = String(phone).replace(/\D/g, "");
  document.getElementById("cmRoot").classList.add("con-charla");
  cmPintarBandeja();
  document.getElementById("cmChat").innerHTML = `<div class="cm-vacio">Cargando la charla…</div>`;
  await Promise.all([cmCargarHilo(true), cmCargarFicha()]);
  conv({ action: "mark_read", phone: G.convSel }).catch(() => {});
}
async function cmCargarHilo(bajar) {
  const phone = G.convSel;
  if (!phone) return;
  try {
    const d = await conv({ action: "thread", phone });
    if (phone !== G.convSel) return;
    G.hilo = d;
    cmPintarChat(bajar);
  } catch (e) { document.getElementById("cmChat").innerHTML = `<div class="cm-vacio">No se pudo abrir: ${gesc(e.message)}</div>`; }
}
function cmConvActual() { return G.convs.find((c) => c.phone === G.convSel) || { phone: G.convSel, estado_ui: "bot" }; }
function esMia() { const ctl = G.hilo?.control || {}; return ctl.modo_humano && G.miNombre && ctl.agente === G.miNombre; }

function cmPintarChat(bajar) {
  // El refresco (cada 45 s) redibuja el hilo: si estabas abajo (o es otra charla) queda abajo, en el último
  // mensaje; si habías subido a leer, queda donde estabas. Antes volvía siempre arriba de todo.
  const hPrev = document.getElementById("cmHilo");
  const mismo = hPrev && hPrev.dataset.phone === G.convSel;
  const estabaAbajo = !mismo || hPrev.scrollHeight - hPrev.scrollTop - hPrev.clientHeight < 80;
  const scrollPrev = mismo ? hPrev.scrollTop : 0;
  const c = cmConvActual(), d = G.hilo || {}, ctl = d.control || {};
  const estado = ctl.modo_humano ? "humano" : c.estado_ui === "humano" ? "bot" : c.estado_ui;
  const min = sinResponder(c);
  const n = nombreConv(c);
  const asignada = ctl.modo_humano ? `Asignada a ${gesc(ctl.agente || "—")}` : c.tomada_por ? `La tomó ${gesc(c.tomada_por)} en Planify` : "Sin asignar";
  const mia = esMia();
  const acciones = [
    !mia ? `<button class="g-btn prim" onclick="cmAccion('tomar')">Tomar conversación</button>` : "",
    estado !== "bot" && estado !== "resuelta" ? `<button class="g-btn" onclick="cmAccion('devolver')">Devolver al bot</button>` : "",
    estado !== "resuelta" ? `<button class="g-btn" onclick="cmAccion('resolver')">Marcar resuelta</button>` : "",
    `<button class="g-btn cm-ficha-cerrar" onclick="document.getElementById('cmRoot').classList.add('ficha-abierta')">Ficha del cliente</button>`,
  ].join("");
  // Hilo: mensajes + eventos, en orden
  const items = (d.messages || []).map((m) => ({ tipo: "m", at: m.created_at, m })).concat((d.eventos || []).map((e) => ({ tipo: "e", at: e.at, e })))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let ultDia = "";
  const hilo = items.map((it) => {
    const dia = fechaCorta(it.at);
    let sep = "";
    if (dia !== ultDia) { ultDia = dia; sep = `<div class="dia">${dia === fechaCorta(new Date().toISOString()) ? "Hoy" : dia}</div>`; }
    if (it.tipo === "e") return sep + `<div class="sys">${gesc(it.e.texto)} · ${hora(it.at)}</div>`;
    const m = it.m, body = String(m.body || "");
    if (m.direction === "in") return sep + `<div class="bb in">${gesc(body)}<div class="h">${hora(m.created_at)}</div></div>`;
    const av = body.match(/^\[Aviso automático (\S+)[^\]]*\]\n?([\s\S]*)$/);
    const pl = body.match(/^\[Plantilla: (\S+)\]\s*([\s\S]*)$/);
    if (av || pl) {
      const x = av || pl;
      return sep + `<div class="bb tpl"><span class="et">Aviso automático · ${gesc(humanizar(x[1]))}</span>${gesc(x[2] || "")}<div class="h">${hora(m.created_at)}</div></div>`;
    }
    if (m.humano) return sep + `<div class="bb hum"><span class="et">${gesc(m.humano)} · humano</span>${gesc(body)}<div class="h">${hora(m.created_at)}</div></div>`;
    return sep + `<div class="bb bot"><span class="et">Bot</span>${gesc(body)}<div class="h">${hora(m.created_at)}</div></div>`;
  }).join("") || `<div class="cm-vacio">Todavía no hay mensajes.</div>`;

  const chat = document.getElementById("cmChat");
  const cajaVieja = document.getElementById("cmTexto")?.value || "";
  chat.innerHTML = `<div class="cm-chat-head">
      <div class="t"><button class="g-btn cm-volver" onclick="document.getElementById('cmRoot').classList.remove('con-charla')">‹ Bandeja</button>
        <b>${n ? gesc(n) : "No identificado"}</b><span class="est ${estado}">${ESTADO_TXT[estado]}</span>${min ? `<span class="${edad(min)}" style="font-size:12px">sin responder hace ${dur(min)}</span>` : ""}</div>
      <div class="sub">${[c.cod_cliente ? `Cód. ${gesc(c.cod_cliente)}` : null, `+${gesc(c.phone)}`, "WhatsApp", c.tema ? `Tema: ${gesc(c.tema)}` : null, asignada].filter(Boolean).join(" · ")}</div>
      <div class="cm-acciones">${acciones}</div>
    </div>
    <div class="cm-hilo" id="cmHilo" data-phone="${gesc(G.convSel)}">${hilo}</div>
    <div class="cm-caja" id="cmCaja">${cmCaja(estado, mia)}</div>`;
  const t = document.getElementById("cmTexto");
  if (t && cajaVieja) t.value = cajaVieja;
  const h = document.getElementById("cmHilo");
  if (h) h.scrollTop = (bajar || estabaAbajo) ? h.scrollHeight : scrollPrev;
}
function ultimoEntrante() {
  const ins = (G.hilo?.messages || []).filter((m) => m.direction === "in");
  return ins.length ? ins[ins.length - 1].created_at : null;
}
function cmCaja(estado, mia) {
  const ctl = G.hilo?.control || {};
  if (!mia) {
    const txt = estado === "bot" ? "La está atendiendo el bot. Para responder vos, tomá la conversación: el bot deja de contestar."
      : estado === "esperando" ? "El bot derivó esta conversación y está esperando a una persona. Tomala para responder."
      : estado === "humano" ? `La está atendiendo ${gesc(ctl.agente || "otra persona")}. Si la tomás vos, queda a tu nombre.`
      : "Conversación resuelta. Si el cliente vuelve a escribir, la atiende el bot.";
    return `<div class="fila"><span class="info">${txt}</span><button class="g-btn prim" onclick="cmAccion('tomar')">Tomar conversación</button></div>`;
  }
  const ult = ultimoEntrante();
  const restan = ult ? 24 * 60 - minDesde(ult) : -1;
  if (restan <= 0) {
    return `<div class="aviso-ambar">${ult ? `Pasaron ${dur(minDesde(ult))} desde el último mensaje del cliente.` : "El cliente todavía no escribió."} WhatsApp sólo permite mandar plantillas aprobadas fuera de las 24 horas. Mandar una plantilla a mano desde acá llega en una próxima etapa; mientras tanto, los avisos de pedidos salen solos.</div>`;
  }
  const envio = G.hilo?.envio || {};
  if (envio.puede === false) {
    return `<div class="aviso-ambar">A este número no le sale nada: ${gesc(envio.motivo || "la llave de envío lo corta.")}</div>
      <textarea id="cmTexto" disabled placeholder="Envíos cortados para este número"></textarea>`;
  }
  return `<div class="info">Respondés como ${gesc(G.miNombre)} · el bot está pausado · ventana de 24 h: quedan ${dur(restan)}</div>
    <textarea id="cmTexto" placeholder="Escribí la respuesta…"></textarea>
    <div class="fila"><span></span><button class="g-btn prim" onclick="cmPrepararEnvio()">Enviar…</button></div>`;
}
function cmPrepararEnvio() {
  const texto = (document.getElementById("cmTexto")?.value || "").trim();
  if (!texto) { toast("Escribí la respuesta primero."); return; }
  const c = cmConvActual(), envio = G.hilo?.envio || {};
  const nota = envio.puede ? `<div class="nota" style="background:var(--ok-bg);color:var(--ok-fg)">Llave en ${LLAVE[envio.llave]?.nombre || envio.llave}: el mensaje sale al cliente apenas confirmes.</div>`
    : `<div class="nota" style="background:var(--wait-bg);color:var(--wait-fg)">El mensaje no va a salir: ${gesc(envio.motivo || "")}</div>`;
  modal(`<h3>Confirmar envío</h3>
    <div class="kv"><span>Para</span><span><b>${gesc(nombreConv(c) || "No identificado")}</b> · +${gesc(c.phone)}</span><span>Canal</span><span>WhatsApp · mensaje de sesión (dentro de las 24 h)</span></div>
    <div class="texto">${gesc(texto)}</div>${nota}
    <div class="botones"><button class="g-btn" onclick="cerrarModal()">Cancelar</button><button class="g-btn prim" id="cmEnviarOk" onclick="cmEnviar()"${envio.puede ? "" : " disabled"}>Enviar</button></div>`);
}
async function cmEnviar() {
  const b = document.getElementById("cmEnviarOk");
  b.disabled = true; b.textContent = "Enviando…";
  const texto = (document.getElementById("cmTexto")?.value || "").trim();
  try {
    await conv({ action: "send", phone: G.convSel, body: texto });
    cerrarModal();
    document.getElementById("cmTexto").value = "";
    toast("Mensaje enviado.");
    await cmCargarHilo(true);
    cmCargar();
  } catch (e) { b.textContent = "Reintentar"; b.disabled = false; toast("No se pudo enviar: " + e.message); }
}
async function cmAccion(accion) {
  try {
    const r = await conv({ action: accion, phone: G.convSel });
    if (accion === "tomar" && r.agente) G.miNombre = r.agente;
    toast(accion === "tomar" ? "Tomaste la conversación: el bot deja de contestar." : accion === "devolver" ? "La conversación volvió al bot." : `Resuelta${r.alertas_cerradas ? ` · ${r.alertas_cerradas} alerta(s) cerrada(s)` : ""}.`);
    await cmCargar();
    await cmCargarHilo(true);
    if (typeof loadAlertas === "function") loadAlertas().catch(() => {});
  } catch (e) { toast("No se pudo: " + e.message); }
}

async function cmCargarFicha() {
  const f = document.getElementById("cmFicha");
  f.innerHTML = `<section><h4>Ficha del cliente</h4><div class="cm-vacio" style="padding:0">Cargando…</div></section>`;
  try {
    const d = await conv({ action: "ficha", phone: G.convSel });
    const cerrar = `<button class="g-btn cm-ficha-cerrar" style="float:right" onclick="document.getElementById('cmRoot').classList.remove('ficha-abierta')">Cerrar</button>`;
    if (!d.identificado) {
      f.innerHTML = `<section>${cerrar}<h4>Ficha del cliente</h4><div class="rs"><i>No identificado</i></div>
        <div class="kv"><span>Teléfono</span><span>+${gesc(d.phone)}</span></div>
        <p style="font-size:12px;color:var(--g-muted);margin-top:8px;line-height:1.4">No está vinculado a ningún cliente. Mientras no se verifique el teléfono, el bot no le muestra pedidos ni datos de la cuenta.</p>
        <div class="agendar"><b>Agendar a un cliente</b>
          <input id="agQ" placeholder="Código o razón social" oninput="agBuscar()" autocomplete="off">
          <div id="agRes"></div></div></section>
        ${fichaAvisos(d.avisos)}`;
      return;
    }
    const c = d.cliente || {};
    const EP = { entregado: "ok", facturado: "ok", programado: "bot", "en preparacion": "humano", recibido: "gris" };
    f.innerHTML = `<section>${cerrar}<h4>Ficha del cliente</h4><div class="rs">${gesc(c.business_name)}</div><div style="color:var(--g-muted)">Código ${gesc(c.cod_cliente)}</div>
        <div class="kv"><span>CUIT</span><span>${gesc(c.cuit || "—")}</span><span>Teléfono</span><span>+${gesc(d.phone)}</span><span>Localidad</span><span>${gesc(c.localidad || "—")}</span>
        <span>Vendedor</span><span>${gesc(c.vend || "—")}</span><span>Entrega</span><span>${d.entrega ? `<b>${gesc(d.entrega.modo)}</b>${d.entrega.detalle ? " · " + gesc(d.entrega.detalle) : ""}` : "—"}</span></div></section>
      ${d.agendado ? "" : `<section class="agendar"><b>Sin agendar</b><p>Lo reconoce el teléfono del ERP, pero no está agendado: la IA todavía no ve sus pedidos ni descuentos.</p>
        <button class="g-btn prim" onclick="agAgendar('${gesc(c.id)}', this)">Agendar a ${gesc(c.business_name)}</button></section>`}
      <section><h4>Pedidos recientes</h4>${(d.pedidos || []).length ? d.pedidos.map((p) =>
        `<div class="it"><span>Pedido del ${fechaCorta(p.creado)}<br><span style="color:var(--g-muted)">${p.fecha_entrega ? `${p.estado === "entregado" ? "entregado el" : "sale el"} ${ddmm(p.fecha_entrega)}` : "todavía sin fecha de salida"}</span></span><span class="est ${EP[p.estado] || "gris"}">${gesc(humanizar(p.estado))}</span></div>`).join("") : `<div style="color:var(--g-muted);font-size:12px">Sin pedidos en la web.</div>`}</section>
      ${fichaSaldo(d.deuda)}${fichaFacturacion(d.facturas)}
      ${fichaAvisos(d.avisos)}`;
  } catch (e) { f.innerHTML = `<section><h4>Ficha del cliente</h4><div style="color:var(--g-muted)">No se pudo cargar: ${gesc(e.message)}</div></section>`; }
}
// Agendar con un click (Pablo, 29/09): vincula el teléfono de la charla al cliente (bot_customer_whatsapps).
let agT = null;
function agBuscar() {
  clearTimeout(agT);
  agT = setTimeout(async () => {
    const q = (document.getElementById("agQ")?.value || "").trim(), box = document.getElementById("agRes");
    if (!box) return;
    if (q.length < 2) { box.innerHTML = ""; return; }
    try {
      const r = await conv({ action: "buscar_cliente", q });
      box.innerHTML = (r.clientes || []).length ? r.clientes.map((c) => `<div class="it"><span>${gesc(c.business_name)}<br><span style="color:var(--g-muted)">Cód. ${gesc(c.cod_cliente)}${c.localidad ? " · " + gesc(c.localidad) : ""}</span></span>
        <button class="g-btn" onclick="agAgendar('${gesc(c.id)}', this)">Agendar</button></div>`).join("") : `<div style="color:var(--g-muted);font-size:12px">Sin resultados.</div>`;
    } catch (e) { box.textContent = "No se pudo buscar: " + e.message; }
  }, 300);
}
async function agAgendar(customerId, b) {
  b.disabled = true; b.textContent = "Agendando…";
  try {
    const r = await conv({ action: "agendar", phone: G.convSel, customer_id: customerId });
    if (!r.ok) throw new Error(r.error || "error");
    toast(`Agendado a ${r.cliente}${r.principal ? " como número principal" : ""}.`);
    cmCargarFicha();
  } catch (e) { b.disabled = false; b.textContent = "Reintentar"; toast("No se pudo agendar: " + e.message); }
}
// Etapa 6: saldo (GV_Cobranza_Deuda_Viva) y pedidos mandados a facturar (Facturacion_NP), de Gestión.
const ddmm = (f) => (f ? `${String(f).slice(8, 10)}/${String(f).slice(5, 7)}` : "—");
const pesosAR = (n) => "$ " + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fichaSaldo(dv) {
  if (!dv) return `<section><h4>Saldo</h4><div style="color:var(--g-muted);font-size:12px">Gestión no respondió: sin datos de saldo.</div></section>`;
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const cs = dv.comprobantes || [];
  const vencidas = cs.filter((c) => c.vence && c.vence < hoy);
  const vencido = vencidas.reduce((a, c) => a + Number(c.pendiente || 0), 0);
  return `<section><h4>Saldo</h4>${cs.length ? `<div class="rs">${pesosAR(dv.saldo)}</div>
    <div style="font-size:12px;color:var(--g-muted)">${cs.length} factura${cs.length === 1 ? "" : "s"} impaga${cs.length === 1 ? "" : "s"}${vencidas.length ? ` · <b style="color:var(--g-danger)">${pesosAR(vencido)} vencido</b>` : " · nada vencido"}</div>
    ${cs.slice(0, 6).map((c) => `<div class="it"><span>${gesc(c.comprobante)}<br><span style="color:var(--g-muted)">del ${ddmm(c.fecha)} · vence ${ddmm(c.vence)}</span></span><span style="${c.vence && c.vence < hoy ? "color:var(--g-danger);font-weight:700" : ""}">${pesosAR(c.pendiente)}</span></div>`).join("")}
    ${cs.length > 6 ? `<div style="font-size:12px;color:var(--g-muted)">y ${cs.length - 6} más</div>` : ""}` : `<div style="font-size:12px;color:var(--ok-fg)">Sin deuda pendiente.</div>`}
    <div style="font-size:11px;color:var(--g-muted);margin-top:6px">Deuda viva de Cobranzas${dv.calculado_en ? ` · calculada ${fechaCorta(dv.calculado_en)} ${hora(dv.calculado_en)}` : ""}</div></section>`;
}
function fichaFacturacion(fs) {
  if (!fs) return "";
  // Sin número de NP (Pablo, 28/09): se nombra por la fecha de salida.
  return `<section><h4>Pedidos a facturar</h4>${fs.length ? fs.map((f) => `<div class="it"><span>Pedido que sale el ${ddmm(f.fecha_salida)}</span><span class="est ok">Facturación ${f.facturado_at ? fechaCorta(f.facturado_at) : ""}</span></div>`).join("") : `<div style="color:var(--g-muted);font-size:12px">Ninguno en Facturación.</div>`}</section>`;
}
function fichaAvisos(av) {
  const E = { sent: ["Enviado", "ok"], failed: ["Fallido", "esperando"], pending: ["En cola", "gris"], held_no_whitelist: ["Retenido", "humano"] };
  return `<section><h4>Avisos automáticos enviados</h4>${(av || []).length ? av.map((a) => {
    const e = E[a.status] || [humanizar(a.status), "gris"];
    return `<div class="it"><span>${gesc(humanizar(a.template_name || a.context || "mensaje"))}<br><span style="color:var(--g-muted)">${fechaCorta(a.created_at)} ${hora(a.created_at)}</span></span><span class="est ${e[1]}">${e[0]}</span></div>`;
  }).join("") : `<div style="color:var(--g-muted);font-size:12px">Ninguno.</div>`}</section>`;
}

// Las alertas (tabla, aviso lateral, link ?charla=) abren la charla en el Centro de mensajes.
// eslint-disable-next-line no-unused-vars
async function abrirCharla(phone, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const tel = String(phone || "").replace(/\D/g, "");
  if (!tel) return;
  irPagina("conv");
  await cmAbrir(tel);
}

// Badges del menú: alertas abiertas (Tareas), vinculaciones y consultas pendientes.
if (typeof pintarBadgeAlertas === "function") {
  const _pb = pintarBadgeAlertas;
  // eslint-disable-next-line no-global-assign
  pintarBadgeAlertas = function (abiertas, vencidas, urgentes) { _pb(abiertas, vencidas, urgentes); G.alertas = abiertas || 0; renderNav(); };
}

// Arranque: después del login (showApp) se arma el menú, la llave y la bandeja.
function alEntrar() {
  const u = document.getElementById("sbUsuario");
  if (u) u.innerHTML = `<b>${gesc(currentEmail || "")}</b>${esAdmin() ? "Administración · admin" : "Ventas · vendedor"}`;
  if (esAdmin() && typeof sb !== "undefined") {
    sb.from("gestop_users").select("username").eq("email", currentEmail).maybeSingle().then(({ data }) => {
      G.miNombre = (data?.username && String(data.username).trim()) || currentEmail;
      if (u) u.innerHTML = `<b>${gesc(G.miNombre)}</b>Administración · admin`;
    });
  }
  cargarLlave();
  if (esAdmin()) tkContarVinculos();
  if (!new URLSearchParams(location.search).get("charla")) {
    if (esAdmin()) irPagina("conv"); else navSec("com", "pruebas");
  }
  renderNav();
}
const _showAppViejo = showApp;
// eslint-disable-next-line no-global-assign
showApp = function () { _showAppViejo(); alEntrar(); };
// Si el login terminó antes de que cargara este archivo, arrancar igual.
if (document.getElementById("app")?.classList.contains("active")) alEntrar();
setInterval(() => {
  if (!document.getElementById("app")?.classList.contains("active") || !esAdmin()) return;
  cargarLlave();
  if (document.getElementById("pageTareas")?.classList.contains("active")) { if (!document.getElementById("gModal")) tkCargar(); }
  else tkContarVinculos();
  if (document.getElementById("pageConv").classList.contains("active")) {
    cmCargar();
    const escribiendo = (document.getElementById("cmTexto")?.value || "").length > 0;
    if (G.convSel && !escribiendo && !document.getElementById("gModal")) cmCargarHilo(false);
  }
}, 45000);
renderNav();

// ── Centro de mensajes › Tareas (etapa 3) ───────────────────────────────────
// Una sola lista de lo que espera a una persona: teléfonos para verificar (lk_vinculaciones), comprobantes
// (cobranzas), derivaciones y altas de cliente (lk_alertas). Nada de acá le habla a Meta: los avisos de
// aprobar/rechazar un teléfono se encolan en wa_outbox y salen (o no) según la llave.
const TIPO_TK = {
  tel: { nombre: "Verificar teléfono", clase: "tipo-tel" },
  cob: { nombre: "Cobranzas", clase: "tipo-cob" },
  der: { nombre: "Derivaciones", clase: "tipo-der" },
  alta: { nombre: "Alta de cliente", clase: "tipo-alta" },
};
const ESTADO_COMP = { pending: "Sin leer todavía", parsed: "Leído", matched: "Cruzado con una factura", confirmed: "Confirmado",
  rejected: "Rechazado", no_comprobante: "No parece un comprobante", error: "No se pudo leer" };
const NIVEL_RANGO = { rojo: 0, amarillo: 1, verde: 2 };
function tipoDeAlerta(a) {
  if (["comprobante_recibido", "comprobante_error", "pago", "reclamo"].includes(a.categoria)) return "cob";
  if (a.categoria === "alta_cliente") return "alta";
  return "der";
}
async function tkInvoke(fn, body) {
  const { data, error } = await authedInvoke(fn, body);
  if (error) {
    let msg = error.message || "error";
    try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) { /* sin cuerpo */ }
    throw new Error(msg);
  }
  if (data && data.ok === false) throw new Error(data.error || "error");
  if (data && data.error && !data.ok) throw new Error(data.error);
  return data;
}
async function tkContarVinculos() {
  try {
    const r = await tkInvoke("lk_vinculaciones", { action: "list" });
    G.vinculos = (r.pendientes || []).length;
    renderNav();
  } catch (_) { /* el badge queda como estaba */ }
}
async function tkCargar() {
  try {
    const [al, vi] = await Promise.all([
      tkInvoke("lk_alertas", { action: "list", incluir_resueltas: true }),
      tkInvoke("lk_vinculaciones", { action: "list" }),
    ]);
    const hoy = fechaCorta(new Date().toISOString());
    const abiertas = (al.alertas || []).filter((a) => ["pendiente", "notificado"].includes(a.estado));
    G.resueltasHoy = (al.alertas || []).filter((a) => a.atendido_at && fechaCorta(a.atendido_at) === hoy).length;
    const vinc = (vi.pendientes || []).map((v) => ({
      key: "v" + v.id, tipo: "tel", id: v.id, phone: v.telefono, creado: v.creado_en, nivel: v.intentos_24h > 1 ? "amarillo" : "verde",
      motivo: v.tipo === "pedidos_access" ? "Pide ver pedidos" : "Pide vincular el número",
      cliente: v.business_name ? `${v.business_name} (${v.cod_cliente})` : null, v,
    }));
    const alts = abiertas.map((a) => ({
      key: "a" + a.id, tipo: tipoDeAlerta(a), id: a.id, phone: a.phone, creado: a.created_at, nivel: a.nivel || "verde",
      motivo: a.label, cliente: a.cliente || (a.alta?.razon_social ?? null), a,
    }));
    G.tareas = [...vinc, ...alts].sort((x, y) => (NIVEL_RANGO[x.nivel] - NIVEL_RANGO[y.nivel]) || String(x.creado).localeCompare(String(y.creado)));
    G.alertas = alts.length; G.vinculos = vinc.length;
    renderNav();
    tkPintarLista();
    if (G.tareaSel && !G.tareas.some((t) => t.key === G.tareaSel)) G.tareaSel = null;
    tkPintarDetalle();
  } catch (e) {
    document.getElementById("tkLista").innerHTML = `<div class="cm-vacio">No se pudo cargar: ${gesc(e.message)}</div>`;
  }
}
function tkPintarLista() {
  const ts = G.tareas;
  const mas = ts[0];
  document.getElementById("tkResumen").innerHTML =
    `<b>${ts.length}</b> pendiente${ts.length === 1 ? "" : "s"} · ${G.resueltasHoy} resuelta${G.resueltasHoy === 1 ? "" : "s"} hoy` +
    (mas ? ` · la más vieja: ${dur(Math.max(...ts.map((t) => minDesde(t.creado))))}` : "") +
    `<button class="g-btn" onclick="irPagina('alertas')" title="Vencimientos por tipo y alertas resueltas">Vencimientos…</button>`;
  const cuenta = (t) => ts.filter((x) => x.tipo === t).length;
  document.getElementById("tkChips").innerHTML = [["todas", "Todas", ts.length], ...Object.entries(TIPO_TK).map(([k, v]) => [k, v.nombre, cuenta(k)])]
    .map(([k, n, c]) => `<button class="cm-chip${G.filtroTipo === k ? " activo" : ""}" onclick="G.filtroTipo='${k}';tkPintarLista()">${n} · ${c}</button>`).join("");
  const vis = ts.filter((t) => G.filtroTipo === "todas" || t.tipo === G.filtroTipo);
  const tkL = document.getElementById("tkLista"), tkScroll = tkL.scrollTop;
  requestAnimationFrame(() => { tkL.scrollTop = tkScroll; });
  tkL.innerHTML = vis.length ? vis.map((t) => {
    const min = minDesde(t.creado);
    return `<div class="cm-fila tk-fila${G.tareaSel === t.key ? " sel" : ""}" onclick="tkAbrir('${t.key}')">
      <div class="l1"><b><span class="tk-dot ${t.nivel}"></span>${gesc(t.motivo)}</b><span class="${edad(min)}">${dur(min)}</span></div>
      <div class="l2">${t.cliente ? gesc(t.cliente) : `<i>No identificado</i> · +${gesc(t.phone)}`}</div>
      <div class="l3"><span class="est ${TIPO_TK[t.tipo].clase}">${TIPO_TK[t.tipo].nombre}</span>${t.a?.tomada_por ? `<span class="meta">→ ${gesc(t.a.tomada_por)}</span>` : ""}<span class="canal">WA</span></div>
    </div>`;
  }).join("") : `<div class="cm-vacio">${ts.length ? "No hay tareas de este tipo." : "No hay nada esperando a una persona."}</div>`;
}
function tkAbrir(key) {
  G.tareaSel = key;
  document.getElementById("tkRoot").classList.add("con-detalle");
  tkPintarLista();
  tkPintarDetalle();
}
function tkVolver() { document.getElementById("tkRoot").classList.remove("con-detalle"); }
const tkActual = () => G.tareas.find((t) => t.key === G.tareaSel);
const kv = (pares) => `<div class="kv">${pares.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join("")}</div>`;
const pesos = (n, mon) => (n === null || n === undefined ? null : `${mon && mon !== "ARS" ? mon + " " : "$ "}${Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
function tkPintarDetalle() {
  const d = document.getElementById("tkDetalle");
  const t = tkActual();
  if (!t) { d.innerHTML = `<div class="cm-vacio">Elegí una tarea de la lista.</div>`; return; }
  const volver = `<button class="g-btn tk-volver" onclick="tkVolver()">‹ Tareas</button>`;
  const cab = `<div class="tit"><span class="tk-dot ${t.nivel}"></span><b>${gesc(t.motivo)}</b><span class="est ${TIPO_TK[t.tipo].clase}">${TIPO_TK[t.tipo].nombre}</span></div>
    <div style="color:var(--g-muted);font-size:12px">Esperando hace ${dur(minDesde(t.creado))} · desde ${fechaCorta(t.creado)} ${hora(t.creado)}</div>`;
  const verConv = `<button class="g-btn" onclick="abrirCharla('${gesc(t.phone)}')">Ver conversación</button>`;
  if (t.tipo === "tel") {
    const v = t.v;
    const tels = (v.telefonos_erp || []).filter(Boolean);
    d.innerHTML = `${volver}<div class="tk-card">${cab}
      ${kv([["Escribió desde", `+${gesc(v.telefono)}`], ["Dice ser", v.business_name ? `<b>${gesc(v.business_name)}</b> · Cód. ${gesc(v.cod_cliente)}` : "—"],
        ["CUIT informado", gesc(v.cuit_normalizado || "—")], ["Pide", v.tipo === "pedidos_access" ? "Ver los pedidos de la cuenta" : "Vincular el número a la cuenta"],
        ["Número principal hoy", v.principal_actual ? `+${gesc(v.principal_actual)} (se le avisa si aprobás)` : "Ninguno: este queda como principal"],
        v.was_timeout ? ["Nota", "El bot no pudo verificarlo solo y lo pasó a revisión"] : ["", ""]])}
      ${v.intentos_24h > 1 ? `<div class="alerta">Probó ${v.intentos_24h} CUIT distintos en 24 h antes de acertar · revisar con cuidado</div>` : ""}
      <h4>Teléfonos del cliente en el ERP</h4>
      <div class="tk-tels">${tels.length ? tels.map((n) => `<div class="it"><span>+${gesc(n)}</span><a href="tel:+${gesc(String(n).replace(/\D/g, ""))}">Llamar</a></div>`).join("") : `<div style="color:var(--g-muted)">El ERP no tiene teléfonos cargados para este cliente.</div>`}</div>
      <div class="cm-acciones"><button class="g-btn prim" onclick="tkModalVinculo('approve')">Aprobar teléfono…</button><button class="g-btn" onclick="tkModalVinculo('reject')">Rechazar…</button>${verConv}</div>
    </div>`;
    return;
  }
  const a = t.a;
  const acciones = `<div class="cm-acciones"><button class="g-btn prim" onclick="tkTomar()">Tomar y abrir conversación</button>
    <button class="g-btn" onclick="tkResolver('atendido')">Marcar resuelta</button><button class="g-btn" onclick="tkResolver('descartado')">Descartar</button></div>`;
  const quien = kv([["Cliente", a.cliente ? `<b>${gesc(a.cliente)}</b>` : "<i>No identificado</i>"], ["Teléfono", `+${gesc(a.phone || "")}`],
    ["Pedido", a.pedido_fecha ? `del ${gesc(a.pedido_fecha)}` : null], ["La tomó", a.tomada_por ? gesc(a.tomada_por) : null]]);
  let cuerpo = "";
  if (t.tipo === "cob") {
    const c = a.comprobante;
    if (a.categoria === "comprobante_error") {
      cuerpo = `<h4>Qué pasó</h4><div class="alerta">El cliente mandó un comprobante y el bot no lo pudo guardar${a.error_detalle ? ` (${gesc(a.error_detalle)})` : ""}.</div>
        <div class="aviso">Pedíselo de nuevo desde la conversación.</div>`;
    } else if (c) {
      cuerpo = `<h4>Comprobante</h4>${kv([["Tipo", c.tipo ? gesc(humanizar(c.tipo)) : null], ["Importe", pesos(c.monto_total, c.moneda)],
        ["Fecha de la operación", c.fecha_operacion ? gesc(c.fecha_operacion.split("-").reverse().join("/")) : null],
        ["Lectura automática", c.status ? gesc(ESTADO_COMP[c.status] || humanizar(c.status)) : null], ["Texto que mandó", c.caption ? gesc(c.caption) : null]])}
        <div class="aviso">Todavía no se cruza con la factura: la diferencia contra lo facturado hay que mirarla a mano.</div>
        <div class="cm-acciones"><button class="g-btn" onclick="tkAdjunto('${gesc(c.id)}')">Ver adjunto</button></div>`;
    }
  } else if (t.tipo === "alta") {
    const l = a.alta || {};
    cuerpo = `<h4>Datos que cargó el bot</h4>${kv([["Razón social", l.razon_social ? `<b>${gesc(l.razon_social)}</b>` : null], ["Contacto", gesc(l.nombre_contacto || "")],
      ["CUIT", gesc(l.cuit || "")], ["Domicilio", gesc([l.direccion, l.localidad].filter(Boolean).join(" · "))], ["Teléfono", gesc(l.telefono || "")],
      ["Mail", gesc(l.mail || "")], ["Expreso", gesc(l.expreso_nombre || "")], ["Tipo de comercio", gesc(l.tipo_comercio || "")],
      ["Ya vende LK", l.ya_vende_lk === true ? "Sí" : l.ya_vende_lk === false ? "No" : null], ["Le compra a", gesc(l.a_quien_compra || "")]])}
      <div class="aviso">El alta se carga en el ERP a mano. Después aprobala acá: se le avisa al cliente por WhatsApp (sale según la llave).</div>
      <div class="cm-acciones"><button class="g-btn prim" onclick="tkModalAlta('approve')">Aprobar alta…</button><button class="g-btn" onclick="tkModalAlta('reject')">Rechazar…</button></div>`;
  } else {
    cuerpo = a.texto ? `<h4>Último mensaje del cliente</h4><div class="cita">${gesc(a.texto)}</div>` : "";
  }
  d.innerHTML = `${volver}<div class="tk-card">${cab}${quien}${cuerpo}${acciones.replace("</div>", `${verConv}</div>`)}</div>`;
}
async function tkTomar() {
  const t = tkActual(); if (!t) return;
  try {
    await conv({ action: "tomar", phone: t.phone });
    toast("Tomaste la conversación: el bot deja de contestar.");
    await abrirCharla(t.phone);
  } catch (e) { toast("No se pudo: " + e.message); }
}
async function tkResolver(estado) {
  const t = tkActual(); if (!t || !t.a) return;
  try {
    await tkInvoke("lk_alertas", { action: "resolver", id: t.a.id, estado });
    toast(estado === "atendido" ? "Tarea resuelta." : "Tarea descartada.");
    G.tareaSel = null; tkVolver();
    await tkCargar();
    if (typeof loadAlertas === "function") loadAlertas().catch(() => {});
  } catch (e) { toast("No se pudo: " + e.message); }
}
async function tkAdjunto(id) {
  const w = window.open("about:blank", "_blank");
  try {
    const r = await tkInvoke("lk_alertas", { action: "adjunto", comprobante_id: id });
    if (w) w.location = r.url; else location.href = r.url;
  } catch (e) { if (w) w.close(); toast("No se pudo abrir: " + e.message); }
}
function notaLlaveCola() {
  const m = G.llave?.modo;
  if (m === "1") return `<div class="nota" style="background:var(--ok-bg);color:var(--ok-fg)">Llave en PRODUCCIÓN: el aviso sale por la cola en menos de 2 minutos.</div>`;
  if (m === "prueba") return `<div class="nota" style="background:var(--wait-bg);color:var(--wait-fg)">Llave en PRUEBA: el aviso queda en la cola y sólo sale si el número está en la lista de prueba.</div>`;
  return `<div class="nota" style="background:var(--wait-bg);color:var(--wait-fg)">Llave APAGADA: el aviso queda en la cola y no sale.</div>`;
}
function tkModalVinculo(decision) {
  const t = tkActual(); if (!t || t.tipo !== "tel") return;
  const v = t.v, aprobar = decision === "approve";
  const efecto = aprobar
    ? (v.tipo === "pedidos_access" ? "El número queda habilitado para ver los pedidos de la cuenta."
      : `El número queda vinculado a <b>${gesc(v.business_name || "")}</b>${v.principal_actual ? ` y se avisa al número principal (+${gesc(v.principal_actual)})` : " como número principal"}.`)
    : "La solicitud queda rechazada. El número no se vincula.";
  modal(`<h3>${aprobar ? "Aprobar teléfono" : "Rechazar teléfono"}</h3>
    <div class="kv"><span>Número</span><span>+${gesc(v.telefono)}</span><span>Cliente</span><span>${gesc(v.business_name || "—")} · Cód. ${gesc(v.cod_cliente ?? "—")}</span></div>
    <div>${efecto}</div>
    ${aprobar ? "" : `<label style="font-size:12px;color:var(--g-muted)">Motivo (va en el mensaje al cliente)</label><textarea id="tkMotivo" oninput="tkPrevRechazo()" placeholder="ej. el CUIT no coincide con el titular"></textarea>`}
    <div style="font-size:12px;color:var(--g-muted)">Mensaje que se le manda a +${gesc(v.telefono)}:</div>
    <div class="texto" id="tkAvisoTxt">${gesc(aprobar ? v.aviso_aprobar : v.aviso_rechazar.replace(" ({{motivo}})", ""))}</div>${notaLlaveCola()}
    <div class="botones"><button class="g-btn" onclick="cerrarModal()">Cancelar</button><button class="g-btn prim" id="tkDecidirOk" onclick="tkDecidir('${decision}')"${aprobar ? "" : " disabled"}>${aprobar ? "Aprobar" : "Rechazar"}</button></div>`);
}
function tkPrevRechazo() {
  const t = tkActual(), m = (document.getElementById("tkMotivo")?.value || "").trim();
  document.getElementById("tkAvisoTxt").textContent = m ? t.v.aviso_rechazar.replace("{{motivo}}", m) : t.v.aviso_rechazar.replace(" ({{motivo}})", "");
  document.getElementById("tkDecidirOk").disabled = !m;
}
async function tkDecidir(decision) {
  const t = tkActual(); if (!t) return;
  const b = document.getElementById("tkDecidirOk");
  const motivo = (document.getElementById("tkMotivo")?.value || "").trim();
  b.disabled = true; b.textContent = "Guardando…";
  try {
    await tkInvoke("lk_vinculaciones", { action: "decide", request_id: t.v.id, decision, motivo: motivo || undefined });
    cerrarModal();
    toast(decision === "approve" ? "Teléfono aprobado. El aviso quedó en la cola." : "Teléfono rechazado. El aviso quedó en la cola.");
    G.tareaSel = null; tkVolver();
    await tkCargar();
  } catch (e) { b.disabled = false; b.textContent = "Reintentar"; toast("No se pudo: " + e.message); }
}

// ── Centro de mensajes › Salientes (etapa 4) ────────────────────────────────
// Qué salió del número según Meta (de cualquier origen) y qué quedó en la cola del bot. Sólo lectura.
const TIPO_AVISO = {
  pedido_recibido: "Pedido recibido", pedido_programado: "Programado", pedido_programado_retira: "Programado · retira",
  pedido_programado_expreso: "Programado · expreso", pedido_reprogramado: "Reprogramado", pedido_en_viaje: "En viaje",
  pedido_en_viaje_expreso: "En viaje · expreso", pedido_listo_retirar: "Listo para retirar", pedido_entregado: "Entregado",
  pedido_facturado_sale: "Facturado", pedido_recordatorio_25: "Recordatorio", order_created: "Pedido creado",
  tracking_programado: "Programado (tracking)", tracking_fecha_cambio: "Cambio de fecha", tracking_entregado: "Entregado (tracking)",
  vinculacion_aprobada: "Teléfono aprobado", vinculacion_rechazada: "Teléfono rechazado", vinculacion_aviso_principal: "Aviso al principal",
  hello_world: "Prueba de Meta", texto: "Texto libre",
};
const nfmt = (n) => Number(n || 0).toLocaleString("es-AR");
const usd = (n) => "USD " + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? Math.round((a / b) * 100) + " %" : "—");
const celda = (n, cls) => `<td class="${n ? cls || "" : "cero"}">${nfmt(n)}</td>`;
async function slCargar() {
  const root = document.getElementById("slRoot");
  if (!G.sl) root.innerHTML = `<div class="cm-vacio">Cargando…</div>`;
  try {
    G.sl = await conv({ action: "salientes", dias: G.slDias });
    slPintar();
  } catch (e) { root.innerHTML = `<div class="cm-vacio">No se pudo cargar: ${gesc(e.message)}</div>`; }
}
function slPintar() {
  const r = G.sl, t = r.total;
  const dd = (d) => d.split("-").reverse().slice(0, 2).join("/");
  const hoy = r.hasta;
  const maxDia = Math.max(1, ...r.por_dia.map((d) => d.salieron));
  const filas = r.por_dia.slice().reverse().map((d) => {
    const w = (x) => `${(x / maxDia) * 100}%`;
    return `<tr class="${d.dia === hoy ? "hoy" : ""}"><td>${dd(d.dia)}${d.dia === hoy ? " · HOY" : ""}</td>${celda(d.salieron)}${celda(d.bot)}${celda(d.otros)}${celda(d.utility)}${celda(d.marketing)}${celda(d.service)}${celda(d.entregados)}${celda(d.leidos)}${celda(d.fallidos, "mal")}${celda(d.retenidos, "ret")}<td class="${d.costo ? "" : "cero"}">${usd(d.costo)}</td>
      <td><div class="sl-barra"><i class="b-bot" style="width:${w(d.bot - 0)}"></i><i class="b-otr" style="width:${w(Math.max(0, d.otros - d.fallidos))}"></i><i class="b-fal" style="width:${w(Math.min(d.fallidos, d.otros))}"></i></div></td></tr>`;
  }).join("");
  const maxMot = Math.max(1, ...r.fallidos_por_motivo.map((m) => m.cant));
  const llave = G.llave?.modo === "1" ? "PRODUCCIÓN" : G.llave?.modo === "prueba" ? "PRUEBA" : "APAGADO";
  const cambios = (r.cambios_llave || []).map((c) => `${fechaCorta(c.creado_en)} ${hora(c.creado_en)}: ${gesc(c.usuario)} pasó a ${c.modo_nuevo === "1" ? "PRODUCCIÓN" : c.modo_nuevo === "prueba" ? "PRUEBA" : "APAGADO"}`).join(" · ");
  document.getElementById("slRoot").innerHTML = `
    <div class="sl-top">Período <select onchange="G.slDias=Number(this.value);slCargar()">${[7, 14, 30].map((n) => `<option value="${n}"${n === r.dias ? " selected" : ""}>Últimos ${n} días</option>`).join("")}</select>
      <span>${dd(r.desde)} al ${dd(r.hasta)} · llave hoy en <b>${llave}</b>${cambios ? ` · cambios: ${cambios}` : ""}</span>
      <button class="g-btn" style="margin-left:auto" onclick="slCargar()">Actualizar</button></div>
    <div class="sl-kpis">
      <div class="sl-kpi"><span>Salieron del número</span><b>${nfmt(t.salieron)}</b><i>${nfmt(t.bot)} del bot · ${nfmt(t.otros)} de otros</i></div>
      <div class="sl-kpi"><span>Avisos cobrables</span><b>${nfmt(t.utility + t.marketing)}</b><i>${nfmt(t.utility)} utilidad · ${nfmt(t.marketing)} marketing</i></div>
      <div class="sl-kpi"><span>Fallidos</span><b style="color:${t.fallidos ? "var(--g-danger)" : "inherit"}">${nfmt(t.fallidos)}</b><i>${pct(t.fallidos, t.salieron)} de lo que salió</i></div>
      <div class="sl-kpi"><span>Retenidos por la llave</span><b style="color:${t.retenidos ? "var(--warn)" : "inherit"}">${nfmt(t.retenidos)}</b><i>avisos del bot que no salieron</i></div>
      <div class="sl-kpi"><span>Costo estimado</span><b>${usd(t.costo)}</b><i>entregados × tarifa (utilidad USD ${String(r.tarifas.utility).replace(".", ",")} c/u)</i></div>
      <div class="sl-kpi"><span>Tasa de respuesta</span><b>${pct(t.respondidos, t.cobrables)}</b><i>${nfmt(t.respondidos)} de ${nfmt(t.cobrables)} avisos entregados, en 24 h</i></div>
    </div>
    <div class="sl-card"><h4>Por día</h4>
      <div class="sl-scroll"><table class="sl-tab"><thead><tr><th>Día</th><th>Salieron</th><th>Del bot*</th><th>De otros</th><th>Utilidad</th><th>Marketing</th><th>Conversación<br>(gratis)</th><th>Entregados</th><th>Leídos</th><th>Fallidos</th><th>Retenidos</th><th>Costo</th><th></th></tr></thead>
      <tbody>${filas}<tr class="tot"><td>Total</td>${celda(t.salieron)}${celda(t.bot)}${celda(t.otros)}${celda(t.utility)}${celda(t.marketing)}${celda(t.service)}${celda(t.entregados)}${celda(t.leidos)}${celda(t.fallidos, "mal")}${celda(t.retenidos, "ret")}<td>${usd(t.costo)}</td><td></td></tr></tbody></table></div>
      <div class="sl-ley"><span><i style="background:var(--accent)"></i>Del bot</span><span><i style="background:#8a8577"></i>De otros sistemas o personas</span><span><i style="background:#c62828"></i>Fallidos</span></div>
      <div class="nota">* "Del bot": exacto para los avisos de la cola desde el 28/09 (se guarda el ID de Meta); las respuestas del bot en la charla y lo anterior se cuentan por teléfono y hora (±3 min). "De otros" es lo que sale del mismo número desde otros sistemas o desde la app.</div>
    </div>
    <div class="sl-2col">
      <div class="sl-card"><h4>Fallidos por motivo</h4>${r.fallidos_por_motivo.length ? `<div class="sl-mot">${r.fallidos_por_motivo.map((m) => `<span>${gesc(m.texto)} <span style="color:var(--g-muted)">(${gesc(m.codigo)})</span></span><div class="bar" style="width:${(m.cant / maxMot) * 100}%"></div><b>${nfmt(m.cant)}</b>`).join("")}</div>` : `<div class="nota">No falló ningún mensaje en el período.</div>`}</div>
      <div class="sl-card"><h4>Avisos del bot por tipo (cola)</h4>${r.por_tipo.length ? `<div class="sl-scroll"><table class="sl-tab"><thead><tr><th>Aviso</th><th>Encolados</th><th>Enviados</th><th>Fallidos</th><th>Retenidos</th><th>En cola</th></tr></thead><tbody>${r.por_tipo.map((x) => `<tr><td>${gesc(TIPO_AVISO[x.tipo] || humanizar(x.tipo))}</td>${celda(x.encolados)}${celda(x.enviados)}${celda(x.fallidos, "mal")}${celda(x.retenidos, "ret")}${celda(x.pendientes)}</tr>`).join("")}</tbody></table></div>` : `<div class="nota">El bot no encoló avisos en el período.</div>`}
        <div class="nota">Retenidos = la llave no los dejó salir (modo prueba o apagado).</div></div>
    </div>
    ${r.respuesta.length ? `<div class="sl-card"><h4>Tasa de respuesta por tipo de aviso</h4><div class="sl-scroll"><table class="sl-tab"><thead><tr><th>Categoría</th><th>Entregados</th><th>Respondidos en 24 h</th><th>%</th></tr></thead><tbody>${r.respuesta.map((x) => `<tr><td>${x.categoria === "utility" ? "Utilidad" : "Marketing"}</td>${celda(x.enviados)}${celda(x.respondidos)}<td>${pct(x.respondidos, x.enviados)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
}

// Alta de cliente: aprobar / rechazar con aviso (lk_alertas alta_decidir). El texto que se muestra es el que
// arma el backend (avisos_alta); el código de cliente es opcional y se suma al mensaje si se carga.
function tkVentanaNota(a) {
  const min = a.ultimo_in_at ? minDesde(a.ultimo_in_at) : null;
  if (min !== null && min < 1440) return "";
  return `<div class="nota" style="background:var(--wait-bg);color:var(--wait-fg)">${min === null ? "No hay mensajes del cliente registrados" : `El cliente escribió por última vez hace ${dur(min)}`}: pasadas 24 h, Meta no deja mandar texto libre y el aviso va a fallar. La decisión se guarda igual; avisale por teléfono.</div>`;
}
function tkModalAlta(decision) {
  const t = tkActual(); if (!t || t.tipo !== "alta") return;
  const a = t.a, l = a.alta || {}, av = a.avisos_alta || {}, aprobar = decision === "approve";
  modal(`<h3>${aprobar ? "Aprobar alta de cliente" : "Rechazar alta de cliente"}</h3>
    <div class="kv"><span>Comercio</span><span><b>${gesc(l.razon_social || a.cliente || "—")}</b></span><span>CUIT</span><span>${gesc(l.cuit || "—")}</span><span>Teléfono</span><span>+${gesc(a.phone || "")}</span></div>
    ${aprobar ? `<label style="font-size:12px;color:var(--g-muted)">Código de cliente en el ERP (opcional, va en el mensaje)</label>
      <input id="tkCod" inputmode="numeric" oninput="tkPrevAlta()" style="padding:8px;border:1px solid var(--line);background:var(--g-bg);color:var(--ink);border-radius:2px" placeholder="ej. 4312">` : ""}
    <div style="font-size:12px;color:var(--g-muted)">Mensaje que se le manda:</div>
    <div class="texto" id="tkAvisoTxt">${gesc(aprobar ? av.aprobar : av.rechazar)}</div>${tkVentanaNota(a)}${notaLlaveCola()}
    <div class="botones"><button class="g-btn" onclick="cerrarModal()">Cancelar</button><button class="g-btn prim" id="tkDecidirOk" onclick="tkDecidirAlta('${decision}')">${aprobar ? "Aprobar" : "Rechazar"}</button></div>`);
}
function tkPrevAlta() {
  const t = tkActual(), av = t.a.avisos_alta || {};
  const cod = (document.getElementById("tkCod")?.value || "").replace(/\D/g, "");
  document.getElementById("tkAvisoTxt").textContent = cod ? av.aprobar_con_codigo.replace("{{cod}}", cod) : av.aprobar;
}
async function tkDecidirAlta(decision) {
  const t = tkActual(); if (!t) return;
  const b = document.getElementById("tkDecidirOk");
  const cod = (document.getElementById("tkCod")?.value || "").replace(/\D/g, "");
  b.disabled = true; b.textContent = "Guardando…";
  try {
    const r = await tkInvoke("lk_alertas", { action: "alta_decidir", id: t.a.id, decision, cod_cliente: cod || undefined });
    cerrarModal();
    toast((decision === "approve" ? "Alta aprobada. " : "Alta rechazada. ") + (r.aviso_encolado ? "El aviso quedó en la cola." : "No se pudo encolar el aviso: " + (r.error_aviso || "")));
    G.tareaSel = null; tkVolver();
    await tkCargar();
  } catch (e) { b.disabled = false; b.textContent = "Reintentar"; toast("No se pudo: " + e.message); }
}
