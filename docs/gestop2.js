// GestOp · rediseño (Claude Design, 28/09) — etapa 1 (menú por módulos, header con pestañas, franja de la
// llave, modo oscuro) y etapa 2 (Centro de mensajes › Conversaciones). Se carga DESPUÉS del script de
// index.html y se engancha a sus funciones (showPage, showConfigTab, showAgenteTab, authedInvoke…).
/* global authedInvoke, currentRole, currentEmail, sb, showConfigTab, showAgenteTab, switchChatTab, esc, loadAlertas, pintarBadgeAlertas */

var G = {
  mod: "com", sec: "conv", abiertos: { com: true },
  esperando: 0, alertas: 0, vinculos: 0, consultas: 0,
  llave: null, miNombre: null,
  convs: [], convSel: null, hilo: null, ficha: null, filtroEstado: "todas", filtroTema: "", filtroEspera: 0, buscar: "",
};
const esAdmin = () => currentRole === "admin";
const gesc = (s) => (typeof esc === "function" ? esc(String(s ?? "")) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

// ── Módulos y secciones (mismo orden que el diseño) ─────────────────────────
const MODULOS = [
  { id: "com", nombre: "Comunicaciones", titulo: "Centro de mensajes", secciones: [
    { id: "conv", nombre: "Conversaciones", admin: true, badge: () => G.esperando, abrir: () => irPagina("conv") },
    { id: "tareas", nombre: "Tareas", admin: true, badge: () => G.alertas, abrir: () => irPagina("alertas") },
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
const PAGINA_A = { conv: ["com", "conv"], alertas: ["com", "tareas"], chat: ["com", "pruebas"], dash: ["dash", null], config: ["cfg", null], agente: ["ag", null] };

// ── showPage extendido: suma la página nueva del Centro de mensajes ─────────
const _showPageViejo = showPage;
function irPagina(p) {
  _showPageViejo(p === "conv" ? "__ninguna__" : p);
  document.getElementById("pageConv").classList.toggle("active", p === "conv");
  const [m, s] = PAGINA_A[p] || [G.mod, G.sec];
  G.mod = m;
  if (s) G.sec = s;
  G.abiertos[m] = true;
  if (p === "conv") cmCargar();
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
  }).sort((a, b) => (RANGO[a.estado_ui] - RANGO[b.estado_ui]) || (sinResponder(b) - sinResponder(a)) || String(b.last_at).localeCompare(String(a.last_at)));
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
  document.getElementById("cmLista").innerHTML = lista.length ? lista.map((c) => {
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
    <div class="cm-hilo" id="cmHilo">${hilo}</div>
    <div class="cm-caja" id="cmCaja">${cmCaja(estado, mia)}</div>`;
  const t = document.getElementById("cmTexto");
  if (t && cajaVieja) t.value = cajaVieja;
  const h = document.getElementById("cmHilo");
  if (bajar && h) h.scrollTop = h.scrollHeight;
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
        <p style="font-size:12px;color:var(--g-muted);margin-top:8px;line-height:1.4">No está vinculado a ningún cliente. Mientras no se verifique el teléfono, el bot no le muestra pedidos ni datos de la cuenta.</p></section>
        ${fichaAvisos(d.avisos)}`;
      return;
    }
    const c = d.cliente || {};
    const EP = { entregado: "ok", facturado: "ok", programado: "bot", "en preparacion": "humano", recibido: "gris" };
    f.innerHTML = `<section>${cerrar}<h4>Ficha del cliente</h4><div class="rs">${gesc(c.business_name)}</div><div style="color:var(--g-muted)">Código ${gesc(c.cod_cliente)}</div>
        <div class="kv"><span>CUIT</span><span>${gesc(c.cuit || "—")}</span><span>Teléfono</span><span>+${gesc(d.phone)}</span><span>Localidad</span><span>${gesc(c.localidad || "—")}</span>
        <span>Vendedor</span><span>${gesc(c.vend || "—")}</span><span>Entrega</span><span>${d.entrega ? `<b>${gesc(d.entrega.modo)}</b>${d.entrega.detalle ? " · " + gesc(d.entrega.detalle) : ""}` : "—"}</span></div></section>
      <section><h4>Pedidos recientes</h4>${(d.pedidos || []).length ? d.pedidos.map((p) =>
        `<div class="it"><span>Pedido del ${fechaCorta(p.creado)}${p.fecha_entrega ? ` · sale ${String(p.fecha_entrega).slice(8, 10)}/${String(p.fecha_entrega).slice(5, 7)}` : ""}</span><span class="est ${EP[p.estado] || "gris"}">${gesc(humanizar(p.estado))}</span></div>`).join("") : `<div style="color:var(--g-muted);font-size:12px">Sin pedidos en la web.</div>`}</section>
      ${fichaAvisos(d.avisos)}`;
  } catch (e) { f.innerHTML = `<section><h4>Ficha del cliente</h4><div style="color:var(--g-muted)">No se pudo cargar: ${gesc(e.message)}</div></section>`; }
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
  if (document.getElementById("pageConv").classList.contains("active")) {
    cmCargar();
    const escribiendo = (document.getElementById("cmTexto")?.value || "").length > 0;
    if (G.convSel && !escribiendo && !document.getElementById("gModal")) cmCargarHilo(false);
  }
}, 45000);
renderNav();
