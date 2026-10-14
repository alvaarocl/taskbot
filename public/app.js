// taskbot · panel. Vanilla JS (módulos ES), sin dependencias ni build.
// Acceso con passkey (passkey.js); las vistas se pintan con plantillas y se manejan por delegación.
import * as passkey from "./passkey.js";

const $ = (sel, el = document) => el.querySelector(sel);
const TZ = "Europe/Madrid";
const VIEWS = ["hoy", "reuniones", "semana"];

const state = {
  view: "hoy",
  today: null,
  items: [],
  filter: "tareas",
  query: "",
  expandedId: null,
  inbox: [],
  weeks: [],
  openMsg: null,
};

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (opts) => new Intl.DateTimeFormat("es-ES", { timeZone: TZ, ...opts });
const dayLong = (date) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(new Date(date + "T12:00:00Z"));
const dayShort = (date) => fmt({ weekday: "short", day: "numeric", month: "short" }).format(new Date(date + "T12:00:00Z")).replace(/\./g, "");
const hhmm = (iso) => fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const madridDate = (iso) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso))
  .reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

function relative(ms) {
  const h = ms / 3.6e6;
  if (h < 0) return "vencida";
  if (h < 1) return `en ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `en ${Math.round(h)} h`;
  return `en ${Math.round(h / 24)} días`;
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(`/api/${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    showGate();
    throw new Error("unauthorized");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
}

// Fail-safe de motion: si una entrada se quedó a medias (pestaña en segundo plano), a los 1,2 s se muestra igual.
let settleTimer;
function settle(el) {
  el.classList.remove("settled");
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => el.classList.add("settled"), 1200);
}

// ---------- acceso ----------
function gateError(text) {
  const e = $("#gate-error");
  e.textContent = text || "";
  e.hidden = !text;
}

function showGate({ enroll = false, lead } = {}) {
  $("#app").hidden = true;
  $("#gate").hidden = false;
  $("#gate-login").hidden = enroll;
  $("#gate-enroll").hidden = !enroll;
  if (lead) $("#gate-lead").textContent = lead;
  if (enroll) $("#enroll-name").value = passkey.deviceName();
  settle($("#gate"));
}

async function enterApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
  gateError("");
  const v = location.hash.slice(1);
  await go(VIEWS.includes(v) ? v : "hoy", { replace: true });
  refreshInboxDot();
}

$("#login-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  gateError("");
  if (!passkey.supported()) return gateError("Este navegador no admite passkeys. Usa /acceso en Telegram.");
  btn.disabled = true;
  try {
    await passkey.login();
    await enterApp();
  } catch (err) {
    gateError(passkey.explain(err));
  } finally {
    btn.disabled = false;
  }
});

$("#enroll-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  gateError("");
  btn.disabled = true;
  try {
    await passkey.register($("#enroll-name").value.trim());
    toast("Passkey añadida. La próxima vez, Face ID.");
    await enterApp();
  } catch (err) {
    gateError(passkey.explain(err));
  } finally {
    btn.disabled = false;
  }
});
$("#enroll-skip").addEventListener("click", () => enterApp());

// ---------- navegación ----------
async function go(view, { replace = false } = {}) {
  state.view = view;
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.view === view));
  const url = view === "hoy" ? "/" : `/#${view}`;
  history[replace ? "replaceState" : "pushState"](null, "", url);
  render();
  await load(view);
}

document.querySelector(".tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t && t.dataset.view !== state.view) {
    go(t.dataset.view);
    scrollTo({ top: 0 });
  }
});
addEventListener("popstate", () => {
  const v = location.hash.slice(1);
  go(VIEWS.includes(v) ? v : "hoy", { replace: true });
});

// Pestañas de módulos apagados (bandeja de la web, resumen semanal): fuera.
function applyFeatures(f = {}) {
  for (const [view, on] of [["reuniones", f.inbox], ["semana", f.weekly]]) {
    const tab = document.querySelector(`.tab[data-view="${view}"]`);
    if (tab) tab.hidden = !on;
  }
}

async function load(view) {
  try {
    if (view === "hoy") {
      const [today, items] = await Promise.all([api("today"), api("items")]);
      state.today = today;
      applyFeatures(today.features);
      state.items = items.items || [];
      state.subjects = items.subjects || [];
    } else if (view === "reuniones") {
      state.inbox = (await api("inbox")).inbox || [];
    } else if (view === "semana") {
      state.weeks = (await api("weekly")).weeks || [];
    }
    if (state.view === view) render();
    if (view === "reuniones") markMeetingsSeen();
  } catch (e) {
    if (e.message !== "unauthorized") toast(`No se ha podido cargar: ${e.message}`);
  }
}

function render() {
  const el = $("#view");
  el.innerHTML = state.view === "hoy" ? viewToday() : state.view === "reuniones" ? viewMeetings() : viewWeek();
  settle(el);
}

const head = (title, sub) => `
  <header class="vhead">
    <div class="opener"></div>
    <h1 class="vhead__title bar">${esc(title)}</h1>
    ${sub ? `<p class="vhead__sub">${sub}</p>` : ""}
  </header>`;

const skeleton = `<div class="card"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;

// =====================================================================
// HOY
// =====================================================================
function viewToday() {
  const d = state.today;
  if (!d) return head("hoy") + skeleton;
  const { now, agenda, tasks, aula } = d;
  const [weekday, ...rest] = dayLong(now.date).split(", ");
  const freeMin = agenda.free.reduce((n, f) => n + toMin(f.end) - toMin(f.start), 0);
  const classes = agenda.blocks.filter((b) => b.label.startsWith("📚")).length;
  const sub = [
    classes ? plural(classes, "clase", "clases") : null,
    `${(Math.round(freeMin / 6) / 10).toLocaleString("es-ES")} h libres`,
    aula.length ? plural(aula.length, "entrega en 14 días", "entregas en 14 días") : null,
    tasks.overdue.length ? `<span class="chip chip--bad">${plural(tasks.overdue.length, "atrasada", "atrasadas")}</span>` : null,
  ].filter(Boolean).join(" · ");

  return `
    ${head(`${weekday} ${rest.join(" ").split(" ")[0]}`, `${esc(rest.join(", "))} · ${sub}`)}
    <div class="grid grid--today">
      <div class="stack">
        ${cardAgenda(agenda, now)}
      </div>
      <div class="stack">
        ${state.today.features?.moodle ? cardAula(aula, now) : ""}
        ${cardTasks(tasks)}
      </div>
    </div>
    <div class="stack mt">${cardAllItems()}</div>`;
}

function cardAgenda(agenda, now) {
  const cur = toMin(now.time);
  const slots = agenda.blocks.map((b, i) => {
    const past = !b.allDay && toMin(b.end) <= cur;
    const live = !b.allDay && toMin(b.start) <= cur && cur < toMin(b.end);
    return `
      <li class="slot${past ? " slot--past" : ""}${live ? " slot--now" : ""}">
        <span class="slot__time">${b.allDay ? "Todo el día" : `${esc(b.start)}–${esc(b.end)}`}</span>
        <div>
          <div class="slot__label">${esc(b.label)}</div>
          ${b.where ? `<div class="slot__where">${esc(b.where)}</div>` : ""}
        </div>
      </li>`;
  }).join("");
  return `
    <section class="card rise d0">
      <div class="card__head"><h2 class="label label--c">Agenda</h2><span class="card__count">${plural(agenda.blocks.length, "bloque", "bloques")}</span></div>
      ${slots ? `<ol class="agenda">${slots}</ol>` : `<p class="empty">Nada fijo hoy.</p>`}
      <div class="free">
        <span class="label">Huecos libres</span>
        ${agenda.free.length ? agenda.free.map((f) => `<span class="chip chip--ok">${esc(f.start)}–${esc(f.end)}</span>`).join("") : `<span class="empty">Ninguno</span>`}
      </div>
    </section>`;
}

// ---------- bloques: área (Uni, trabajo, personal…) → asignatura ----------
// Plegables; lo plegado se recuerda en este navegador.
const collapsed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem("tb:collapsed") || "[]")); } catch { return new Set(); }
})();
function saveCollapsed() {
  try { localStorage.setItem("tb:collapsed", JSON.stringify([...collapsed])); } catch {}
}

const areaLabel = (a) => (a === "uni" ? "Uni" : a ? a.charAt(0).toUpperCase() + a.slice(1) : "Sin área");
const byDue = (a, b) => (a.due_at || a.due_date || "9999").localeCompare(b.due_at || b.due_date || "9999") ||
  ["urgente", "normal", "algun_dia"].indexOf(a.priority) - ["urgente", "normal", "algun_dia"].indexOf(b.priority);

function bucket(list, keyOf) {
  const m = new Map();
  for (const it of list) {
    const k = keyOf(it) || "";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

function block(key, title, list, inner, level) {
  const late = list.filter((i) => i.due_date && state.today && i.due_date < state.today.now.date && i.status !== "hecha").length;
  return `
    <details class="blk blk--${level}" data-key="${esc(key)}"${collapsed.has(key) ? "" : " open"}>
      <summary><span class="blk__title">${esc(title)}</span><span class="card__count">${list.length}</span>${late ? `<span class="chip chip--bad">${late} atrasada${late > 1 ? "s" : ""}</span>` : ""}</summary>
      ${inner}
    </details>`;
}

/** Lista agrupada: Uni primero (dividida por asignatura), luego el resto de áreas; "Sin área" al final. */
function grouped(list, rowFn, key) {
  const subjects = state.today?.subjects || state.subjects || [];
  const areas = bucket(list, (i) => i.area);
  const order = [...areas.keys()].sort((a, b) =>
    (b === "uni") - (a === "uni") || (a === "") - (b === "") || areas.get(b).length - areas.get(a).length || a.localeCompare(b));
  const rows = (l) => `<ul>${[...l].sort(byDue).map(rowFn).join("")}</ul>`;

  const html = order.map((a) => {
    const items = areas.get(a);
    let inner = rows(items);
    if (a === "uni") {
      const subs = bucket(items, (i) => i.subject);
      const subOrder = [...subs.keys()].sort((x, y) => (x === "") - (y === "") || subjects.indexOf(x) - subjects.indexOf(y));
      if (!(subOrder.length === 1 && subOrder[0] === "")) {
        inner = subOrder.map((sub) => block(`${key}:uni:${sub}`, sub || "General", subs.get(sub), rows(subs.get(sub)), "sub")).join("");
      }
    }
    return { a, items, inner };
  });
  // Con una sola área (p. ej. las entregas, todas de la uni) sobra su cabecera.
  if (html.length === 1) return html[0].inner;
  return html.map(({ a, items, inner }) => block(`${key}:${a}`, areaLabel(a), items, inner, "area")).join("");
}

// Dentro del bloque de su asignatura, " · Estructura de Computadores" sobra.
function shortText(item) {
  const t = String(item.text || "");
  if (!item.subject || !t.includes(" · ")) return t;
  const [head, ...rest] = t.split(" · ");
  const paren = rest.join(" · ").match(/\(.*\)\s*$/);
  return paren ? `${head} ${paren[0].trim()}` : head;
}

function cardAula(aula, now) {
  const nowMs = Date.parse(`${now.date}T${now.time}:00`);
  const row = (a) => {
    const left = Date.parse(`${a.due_at}:00`) - nowMs;
    const tone = left < 24 * 3.6e6 ? "chip--bad" : left < 72 * 3.6e6 ? "chip--warn" : "chip--line";
    const text = a.url
      ? `<a class="row__text" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(shortText(a))}</a>`
      : `<div class="row__text">${esc(shortText(a))}</div>`;
    return `
      <li class="row" data-id="${a.id}">
        ${checkBtn(a.id, false)}
        <div class="row__body">
          ${text}
          <div class="row__meta">
            <span class="chip ${tone}">${relative(left)}</span>
            <span class="chip chip--line">${esc(dayShort(a.due_at.slice(0, 10)))} · ${esc(a.due_at.slice(11, 16))}</span>
          </div>
        </div>
      </li>`;
  };
  return `
    <section class="card rise d1">
      <div class="card__head"><h2 class="label label--c">Entregas · ${esc(state.today?.features?.moodle || "Moodle")}</h2><span class="card__count">14 días</span></div>
      ${aula.length ? grouped(aula, row, "aula") : `<p class="empty">Nada que entregar en dos semanas.</p>`}
    </section>`;
}

const checkBtn = (id, done) =>
  `<button class="check" role="checkbox" aria-checked="${done}" aria-label="${done ? "Marcar pendiente" : "Marcar hecha"}" data-act="toggle" data-id="${id}">${icon("i-check")}</button>`;

function taskRow(t) {
  const meta = [];
  const today = state.today?.now.date;
  if (t.due_date) {
    const tone = t.due_date < today ? "chip--bad" : t.due_date === today ? "chip--warn" : "chip--line";
    meta.push(`<span class="chip ${tone}">${t.due_date === today ? "hoy" : esc(dayShort(t.due_date))}</span>`);
  }
  if (t.priority === "urgente") meta.push(`<span class="chip chip--bad">urgente</span>`);
  if (t.start_at) meta.push(`<span class="chip">bloque ${esc(t.start_at.slice(11, 16))}${t.start_at.slice(0, 10) !== state.today?.now.date ? ` · ${esc(dayShort(t.start_at.slice(0, 10)))}` : ""}</span>`);
  return `
    <li class="row" data-id="${t.id}">
      ${checkBtn(t.id, false)}
      <div class="row__body"><div class="row__text">${esc(shortText(t))}</div>${meta.length ? `<div class="row__meta">${meta.join("")}</div>` : ""}</div>
    </li>`;
}

function cardTasks(tasks) {
  const all = [...tasks.overdue, ...tasks.today, ...tasks.upcoming];
  return `
    <section class="card rise d2">
      <div class="card__head"><h2 class="label label--c">Tareas con fecha</h2><span class="card__count">hasta 7 días</span></div>
      ${all.length ? grouped(all, taskRow, "fecha") : `<p class="empty">Nada con fecha esta semana.</p>`}
    </section>`;
}

// ---------- todas las tareas ----------
const FILTERS = [["tareas", "Tareas"], ["notas", "Notas"], ["material", "Material"], ["hechas", "Hechas"]];
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function visibleItems() {
  const items = state.items;
  if (state.query) {
    const q = norm(state.query);
    return items.filter((i) => norm(i.text).includes(q) || norm(i.category).includes(q) || norm(i.subject).includes(q));
  }
  if (state.filter === "hechas") return items.filter((i) => i.status === "hecha");
  const pend = items.filter((i) => i.status === "pendiente");
  if (state.filter === "tareas") return pend.filter((i) => i.kind === "tarea");
  if (state.filter === "notas") return pend.filter((i) => i.kind === "nota");
  if (state.filter === "material") return pend.filter((i) => i.kind === "material");
  return pend;
}

function cardAllItems() {
  const vis = visibleItems();
  let body;
  if (!vis.length) body = `<p class="empty">${state.query ? "Sin resultados." : "Vacío por aquí."}</p>`;
  else if (!state.query && state.filter !== "hechas") body = grouped(vis, itemRow, `todo:${state.filter}`);
  else body = `<ul class="group">${vis.map(itemRow).join("")}</ul>`;

  return `
    <section class="card rise d3" id="all-items">
      <div class="card__head"><h2 class="label label--c">Todo</h2><span class="card__count">${plural(state.items.filter((i) => i.status === "pendiente").length, "pendiente", "pendientes")}</span></div>
      <div class="tools">
        <form data-form="add"><input class="input" name="text" type="text" placeholder="Añadir tarea o nota… (la IA la clasifica)" autocomplete="off" enterkeyhint="send" /></form>
        <input class="input" data-input="search" type="search" placeholder="Buscar" value="${esc(state.query)}" autocomplete="off" />
      </div>
      <div class="filters" role="group" aria-label="Filtro">
        ${FILTERS.map(([k, l]) => `<button class="filter" data-act="filter" data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join("")}
      </div>
      <div data-list>${body}</div>
    </section>`;
}

function itemRow(item) {
  const done = item.status === "hecha";
  const today = state.today?.now.date;
  const meta = [];
  if (item.due_date && !done) {
    const tone = item.due_date < today ? "chip--bad" : item.due_date === today ? "chip--warn" : "chip--line";
    meta.push(`<span class="chip ${tone}">${item.due_date === today ? "hoy" : esc(dayShort(item.due_date))}</span>`);
  }
  if (item.priority === "urgente" && !done) meta.push(`<span class="chip chip--bad">urgente</span>`);
  if (item.priority === "algun_dia" && !done) meta.push(`<span class="chip chip--line">algún día</span>`);
  // Sin bloques (búsqueda, hechas), el área y la asignatura van como chips.
  if (state.query || state.filter === "hechas") {
    const where = item.subject || (item.area && areaLabel(item.area));
    if (where) meta.push(`<span class="chip chip--line">${esc(where)}</span>`);
    meta.push(`<span class="tag tag--mute">${esc(item.kind)}</span>`);
  }

  const thumbs = (item.attachments || []).map((a) => {
    const src = `/files/${encodeURIComponent(a.r2_key)}`;
    if ((a.mime || "").startsWith("image/")) return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt=""></a>`;
    if ((a.mime || "").startsWith("audio/")) return `<audio controls preload="none" src="${src}"></audio>`;
    return `<a class="chip" href="${src}" target="_blank" rel="noopener">archivo</a>`;
  }).join("");

  const open = state.expandedId === item.id;
  return `
    <li class="row${done ? " row--done" : ""}" data-id="${item.id}">
      ${checkBtn(item.id, done)}
      <div class="row__body" data-act="expand" data-id="${item.id}" aria-expanded="${open}">
        <div class="row__text">${esc((state.query || state.filter === "hechas" ? item.text : shortText(item)) || "(sin texto)")}</div>
        ${meta.length ? `<div class="row__meta">${meta.join("")}</div>` : ""}
        ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
      </div>
      ${open ? itemActions(item) : ""}
    </li>`;
}

function itemActions(item) {
  const opt = (v, cur, label) => `<option value="${v}"${cur === v ? " selected" : ""}>${label}</option>`;
  return `
    <div class="item-actions" data-id="${item.id}">
      <select data-field="priority" aria-label="Prioridad">${opt("urgente", item.priority, "Urgente")}${opt("normal", item.priority, "Normal")}${opt("algun_dia", item.priority, "Algún día")}</select>
      <select data-field="kind" aria-label="Tipo">${opt("tarea", item.kind, "Tarea")}${opt("nota", item.kind, "Nota")}${opt("material", item.kind, "Material")}</select>
      <input type="date" data-field="due_date" value="${esc(item.due_date || "")}" aria-label="Fecha límite" />
      <input type="text" data-field="category" placeholder="categoría" value="${esc(item.category || "")}" size="10" aria-label="Categoría" />
      <button class="btn btn--ghost btn--sm btn--danger" data-act="delete" data-id="${item.id}">Borrar</button>
    </div>`;
}

async function patchItem(id, fields) {
  const { item } = await api(`items/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
  const i = state.items.findIndex((x) => x.id === id);
  if (i >= 0) state.items[i] = { ...item, attachments: state.items[i].attachments };
  return item;
}

function rerenderAllItems() {
  const card = $("#all-items");
  if (!card) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = cardAllItems();
  const fresh = tmp.firstElementChild;
  fresh.classList.remove("rise");
  // conserva el foco y el cursor de la búsqueda mientras se escribe
  const search = card.querySelector('[data-input="search"]');
  const had = document.activeElement === search ? search.selectionStart : null;
  card.replaceWith(fresh);
  if (had !== null) {
    const s = fresh.querySelector('[data-input="search"]');
    s.focus();
    s.setSelectionRange(had, had);
  }
}

// =====================================================================
// REUNIONES Y MENSAJES
// =====================================================================
function viewMeetings() {
  const now = Date.now();
  const meetings = state.inbox.filter((x) => x.kind === "reunion");
  const upcoming = meetings.filter((m) => Date.parse(m.end_at || m.start_at) >= now).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const past = meetings.filter((m) => Date.parse(m.end_at || m.start_at) < now);
  const msgs = state.inbox.filter((x) => x.kind === "mensaje").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const fresh = msgs.filter((m) => m.status === "nuevo").length;
  const live = upcoming.filter((m) => m.status !== "cancelada").length;

  const sub = `${plural(live, "próxima", "próximas")} · ${fresh ? `${plural(fresh, "mensaje nuevo", "mensajes nuevos")}` : plural(msgs.length, "mensaje", "mensajes")} · se borran a los 90 días`;
  return `
    ${head("reuniones", sub)}
    <div class="grid grid--two">
      <section class="card rise d0">
        <div class="card__head"><h2 class="label label--c">Próximas reuniones</h2></div>
        ${upcoming.length ? `<ul>${upcoming.map(meetingRow).join("")}</ul>` : `<p class="empty">Ninguna reservada. Llegan de tu web por el service binding (ver src/inbox.js).</p>`}
        ${past.length ? `<details class="past mt-s"><summary class="label">Pasadas <span class="card__count">${past.length}</span></summary><ul>${past.map(meetingRow).join("")}</ul></details>` : ""}
      </section>
      <section class="card rise d1">
        <div class="card__head"><h2 class="label label--c">Mensajes</h2><span class="card__count">respóndelos desde el email</span></div>
        ${msgs.length ? `<ul>${msgs.map(messageRow).join("")}</ul>` : `<p class="empty">Sin mensajes.</p>`}
      </section>
    </div>`;
}

function meetingRow(m) {
  const d = madridDate(m.start_at);
  const mon = fmt({ month: "short" }).format(new Date(m.start_at)).replace(".", "");
  const cancelled = m.status === "cancelada";
  const soon = !cancelled && Date.parse(m.start_at) - Date.now() < 2 * 3.6e6 && Date.parse(m.end_at) > Date.now();
  return `
    <li class="meet${cancelled ? " meet--cancelled" : ""}">
      <div class="meet__date"><span class="meet__day">${+d.day}</span><span class="meet__mon">${esc(mon)}</span></div>
      <div>
        <div class="meet__who">${esc(m.name)}</div>
        <div class="meet__when">${esc(dayShort(`${d.year}-${d.month}-${d.day}`))} · ${hhmm(m.start_at)}–${hhmm(m.end_at)} · ${m.duration || ""} min</div>
        ${m.message ? `<p class="meet__msg">${esc(m.message)}</p>` : ""}
        <div class="meet__actions">
          ${m.topic ? `<span class="tag tag--line">${esc(m.topic)}</span>` : ""}
          ${cancelled ? `<span class="tag tag--mute">cancelada</span>` : ""}
          ${soon ? `<span class="tag">pronto</span>` : ""}
          ${m.meet && !cancelled ? `<a class="btn btn--sm" href="${esc(m.meet)}" target="_blank" rel="noopener noreferrer">Abrir Meet</a>` : ""}
        </div>
      </div>
    </li>`;
}

function messageRow(m) {
  const open = state.openMsg === m.id;
  const when = fmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(m.created_at.replace(" ", "T") + "Z"));
  return `
    <li class="msg${m.status === "nuevo" ? " msg--new" : ""}${open ? " msg--open" : ""}" data-act="msg" data-id="${esc(m.id)}" tabindex="0" aria-expanded="${open}">
      <div class="msg__head">
        <span class="msg__who">${esc(m.name)}</span>
        ${m.topic ? `<span class="tag tag--line">${esc(m.topic)}</span>` : ""}
        <span class="msg__when">${esc(when)}</span>
      </div>
      <p class="msg__body">${esc(m.message)}</p>
    </li>`;
}

async function markMeetingsSeen() {
  const fresh = state.inbox.filter((x) => x.kind === "reunion" && x.status === "nuevo");
  for (const m of fresh) {
    m.status = "visto";
    api(`inbox/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ status: "visto" }) }).catch(() => {});
  }
  refreshInboxDot();
}

async function refreshInboxDot() {
  try {
    if (state.view !== "reuniones") state.inbox = (await api("inbox")).inbox || [];
    $("#inbox-dot").hidden = !state.inbox.some((x) => x.status === "nuevo");
  } catch {}
}

// =====================================================================
// SEMANA
// =====================================================================
const range = (w) => `${dayShort(w.from)} – ${dayShort(w.to)}`;

function viewWeek() {
  if (!state.weeks.length) {
    return `${head("semana")}
      <section class="card rise"><p class="empty">El primer resumen llega el domingo a las 20:45 (y por Telegram). Si no quieres esperar, escribe <code>/resumen</code> al bot.</p></section>`;
  }
  const [w, ...older] = state.weeks;
  const d = w.data;
  const commits = d.commits.repos.reduce((n, r) => n + r.total, 0);
  const mine = d.commits.repos.reduce((n, r) => n + r.mine, 0);
  return `
    ${head("semana", `${esc(range(d))} · ${esc(w.week)}`)}
    <div class="stats rise d0">
      <div class="stat"><span class="stat__n">${commits}</span><span class="stat__l label">commits</span><span class="stat__s">${mine} tuyos</span></div>
      <div class="stat"><span class="stat__n">${d.tasks.length}</span><span class="stat__l label">tareas</span><span class="stat__s">cerradas</span></div>
      <div class="stat"><span class="stat__n">${d.classes.hours}</span><span class="stat__l label">horas</span><span class="stat__s">de clase</span></div>
    </div>
    <div class="grid grid--two mt">
      <section class="card rise d1">
        <div class="card__head"><h2 class="label label--c">Borrador build in public</h2><span class="card__count">no se publica</span></div>
        ${w.draft ? `<div class="draft" id="draft">${esc(w.draft)}</div>
          <div class="draft__foot"><span>${w.draft.length} caracteres</span><button class="btn btn--sm" data-act="copy">Copiar</button></div>`
          : `<p class="empty">La IA no pudo escribirlo esta vez. Pídelo otra vez con <code>/resumen</code>.</p>`}
      </section>
      <section class="card rise d2">
        <div class="card__head"><h2 class="label label--c">Repos</h2><span class="card__count">${d.commits.repos.length}</span></div>
        ${d.commits.repos.length ? `<ul>${d.commits.repos.map((r) => `
          <li class="repo">
            <div class="repo__name">${esc(r.repo)}<div class="repo__msgs">${esc(r.messages.slice(0, 3).join(" · "))}</div></div>
            <span class="repo__n">${r.total}${r.mine !== r.total ? ` · ${r.mine} tuyos` : ""}</span>
          </li>`).join("")}</ul>` : `<p class="empty">Sin commits esta semana.</p>`}
        ${d.commits.errors?.length ? `<p class="empty">GitHub: ${esc(d.commits.errors[0])}</p>` : ""}
      </section>
      <section class="card rise d3">
        <div class="card__head"><h2 class="label label--c">Tareas cerradas</h2><span class="card__count">${d.tasks.length}</span></div>
        ${d.tasks.length ? `<ul>${d.tasks.map((t) => `<li class="row row--done"><span class="due">✓</span><div class="row__text">${esc(t.text)}</div></li>`).join("")}</ul>` : `<p class="empty">Ninguna.</p>`}
      </section>
      <section class="card rise d4">
        <div class="card__head"><h2 class="label label--c">Clases</h2><span class="card__count">${d.classes.sessions} sesiones</span></div>
        ${Object.keys(d.classes.bySubject).length ? `<ul>${Object.entries(d.classes.bySubject).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<li class="repo"><span class="repo__name">${esc(s)}</span><span class="repo__n">${n}</span></li>`).join("")}</ul>` : `<p class="empty">Sin clases.</p>`}
      </section>
    </div>
    ${older.length ? `
      <section class="card rise weeks d5 mt">
        <div class="card__head"><h2 class="label label--c">Semanas anteriores</h2></div>
        ${older.map((o) => `
          <details class="past">
            <summary><strong>${esc(range(o.data))}</strong> <span class="card__count">· ${o.data.commits.repos.reduce((n, r) => n + r.total, 0)} commits · ${o.data.tasks.length} tareas · ${o.data.classes.hours} h clase</span></summary>
            ${o.draft ? `<div class="draft">${esc(o.draft)}</div>` : ""}
          </details>`).join("")}
      </section>` : ""}`;
}

// =====================================================================
// EVENTOS (delegación sobre la vista)
// =====================================================================
const view = $("#view");

view.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || e.target.closest("a, audio, select, input")) return;
  const id = Number(el.dataset.id);
  const act = el.dataset.act;

  if (act === "toggle") {
    const row = el.closest(".row");
    const done = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(done));
    try {
      await patchItem(id, { status: done ? "hecha" : "pendiente" });
      if (done) toast("Hecha ✓");
      if (row && !row.closest("#all-items")) {
        row.classList.add("row--leaving");
        setTimeout(() => load("hoy"), 260);
      } else rerenderAllItems();
    } catch (err) {
      el.setAttribute("aria-checked", String(!done));
      toast(err.message);
    }
  } else if (act === "expand") {
    state.expandedId = state.expandedId === id ? null : id;
    rerenderAllItems();
  } else if (act === "filter") {
    state.filter = el.dataset.filter;
    state.expandedId = null;
    rerenderAllItems();
  } else if (act === "delete") {
    // Doble toque en vez de confirm(): el primero arma, el segundo borra.
    if (!el.dataset.armed) {
      el.dataset.armed = "1";
      el.textContent = "¿Seguro? Toca otra vez";
      setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = "Borrar"; } }, 3000);
      return;
    }
    await api(`items/${id}`, { method: "DELETE" });
    state.items = state.items.filter((i) => i.id !== id);
    state.expandedId = null;
    rerenderAllItems();
    toast("Borrada");
  } else if (act === "msg") {
    const m = state.inbox.find((x) => x.id === el.dataset.id);
    state.openMsg = state.openMsg === m.id ? null : m.id;
    el.classList.toggle("msg--open", state.openMsg === m.id);
    el.setAttribute("aria-expanded", String(state.openMsg === m.id));
    if (m.status === "nuevo") {
      m.status = "visto";
      el.classList.remove("msg--new");
      api(`inbox/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ status: "visto" }) }).catch(() => {});
      refreshInboxDot();
    }
  } else if (act === "copy") {
    try {
      await navigator.clipboard.writeText($("#draft").textContent);
      toast("Copiado");
    } catch {
      toast("No se ha podido copiar");
    }
  }
});

// Plegar/desplegar un bloque (toggle no burbujea: se escucha en captura).
view.addEventListener("toggle", (e) => {
  const key = e.target.dataset?.key;
  if (!key) return;
  if (e.target.open) collapsed.delete(key);
  else collapsed.add(key);
  saveCollapsed();
}, true);

view.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches('[data-act="msg"]')) {
    e.preventDefault();
    e.target.click();
  }
});

view.addEventListener("change", async (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  const id = Number(e.target.closest(".item-actions").dataset.id);
  try {
    await patchItem(id, { [f]: e.target.value.trim() });
    rerenderAllItems();
  } catch (err) {
    toast(err.message);
  }
});

view.addEventListener("input", (e) => {
  if (e.target.dataset.input !== "search") return;
  state.query = e.target.value.trim();
  rerenderAllItems();
});

view.addEventListener("submit", async (e) => {
  if (e.target.dataset.form !== "add") return;
  e.preventDefault();
  const input = e.target.elements.text;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.disabled = true;
  try {
    const { item } = await api("items", { method: "POST", body: JSON.stringify({ text }) });
    state.items.unshift(item);
    toast(`Guardada como ${item.kind}`);
    rerenderAllItems();
  } catch (err) {
    input.value = text;
    toast(err.message);
  } finally {
    const fresh = $('#all-items [data-form="add"] input');
    if (fresh) fresh.disabled = false;
  }
});

// =====================================================================
// AJUSTES: passkeys y salir
// =====================================================================
const sheet = $("#settings");

async function loadCreds() {
  const list = $("#cred-list");
  try {
    const r = await fetch("/auth/credentials").then((x) => x.json());
    list.innerHTML = (r.credentials || []).map((c) => `
      <li>
        <div>${esc(c.name)}<small>${c.last_used_at ? `usada ${esc(c.last_used_at.slice(0, 10))}` : `creada ${esc(c.created_at.slice(0, 10))}`}</small></div>
        <button type="button" data-cred="${esc(c.id)}">Quitar</button>
      </li>`).join("") || `<li class="empty">Ninguna todavía.</li>`;
  } catch {
    list.innerHTML = `<li class="empty">No se han podido cargar.</li>`;
  }
}

$("#settings-btn").addEventListener("click", () => {
  $("#settings-note").hidden = true;
  loadCreds();
  sheet.showModal();
});
sheet.addEventListener("click", (e) => {
  if (e.target === sheet || e.target.closest("[data-close]")) sheet.close();
});

$("#cred-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cred]");
  if (!b) return;
  if (!b.dataset.armed) {
    b.dataset.armed = "1";
    b.textContent = "¿Seguro?";
    return;
  }
  await fetch(`/auth/credentials/${encodeURIComponent(b.dataset.cred)}`, { method: "DELETE" });
  loadCreds();
});

$("#add-passkey").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const note = $("#settings-note");
  btn.disabled = true;
  try {
    await passkey.register(passkey.deviceName());
    toast("Passkey añadida");
    loadCreds();
  } catch (err) {
    note.textContent = /vuelve a entrar/.test(err.message)
      ? "Por seguridad, solo se puede justo después de entrar: cierra sesión y vuelve a entrar (Face ID o /acceso)."
      : passkey.explain(err);
    note.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await passkey.post("/auth/logout").catch(() => {});
  sheet.close();
  showGate({ lead: "Sesión cerrada." });
});

// =====================================================================
// ARRANQUE
// =====================================================================
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#app").hidden) {
    load(state.view);
    refreshInboxDot();
  }
});

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  // Enlace de /acceso: /recuperar#<token>. Se quita de la barra antes de nada.
  if (location.pathname === "/recuperar") {
    const token = location.hash.slice(1);
    history.replaceState(null, "", "/");
    try {
      await passkey.post("/auth/recover", { token });
      if (passkey.supported()) showGate({ enroll: true, lead: "Enlace aceptado." });
      else await enterApp();
    } catch (e) {
      showGate();
      gateError(e.message);
    }
    return;
  }

  try {
    const s = await fetch("/auth/status").then((r) => r.json());
    if (s.authed) return enterApp();
    showGate({ lead: s.hasCredentials ? "Tu agenda, tus tareas y tu semana." : "Primera vez: escribe /acceso al bot de Telegram y abre el enlace." });
  } catch {
    showGate();
    gateError("Sin conexión con el servidor.");
  }
}

boot();
