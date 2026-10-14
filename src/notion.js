// Notion (opcional): un espacio de trabajo de Notion como parte del "segundo cerebro". Solo lectura.
// Secreto NOTION_TOKEN (conexión interna o token personal); qué bases y campos usar, en config.notion.
//
//   - Eventos: filas de una base (p. ej. "Proyectos") cuyo tipo es un evento → calendario /cal/notion.ics y
//     tu agenda (los que tienen hora ocupan ese hueco; los de días enteros se ven pero no bloquean el día).
//   - Tareas: las que tienen tu fila de miembro en el campo de asignación → tareas de taskbot con hueco;
//     si en Notion pasan a completadas, se cierran aquí.
//   - Conocimiento: el asistente busca páginas y lee su texto (herramienta notion_buscar).

import config from "../config.js";
import { tg, placeTask, itemKeyboard } from "./telegram.js";

const API = "https://api.notion.com/v1";
const VERSION = "2026-03-11";
const K = { ids: "notion:ids", events: "notion:events" };
const PAST_DAYS = 60; // eventos pasados que siguen saliendo en el calendario

const cfg = () => config.notion || null;
export const notionOn = (env) => !!(cfg() && env.NOTION_TOKEN);

async function api(env, path, body) {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": VERSION, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${r.status} ${path}: ${j.message || ""}`);
  return j;
}

const txt = (a) => (a || []).map((t) => t.plain_text).join("");
const norm = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const titleOf = (page) => txt(Object.values(page.properties || {}).find((p) => p.type === "title")?.title).trim();

async function queryAll(env, id, body, max = 300) {
  const out = [];
  let cursor;
  do {
    const j = await api(env, `/data_sources/${id}/query`, { ...body, page_size: 100, start_cursor: cursor });
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && out.length < max);
  return out;
}

// Ids de las bases (por nombre, con los campos que se esperan) y de tu fila de miembro. Se guardan una semana.
async function ids(env) {
  const cached = await env.FILES.get(K.ids, { type: "json" });
  if (cached) return cached;
  const c = cfg();
  const { results } = await api(env, "/search", { page_size: 100, filter: { property: "object", value: "data_source" } });
  const pick = (name, props) => results
    .filter((d) => txt(d.title).trim() === name && props.every((p) => !p || d.properties?.[p]))
    .sort((a, b) => Object.keys(b.properties).length - Object.keys(a.properties).length)[0]?.id || null;
  const out = {
    events: c.events ? pick(c.events.database, [c.events.date, c.events.type]) : null,
    tasks: c.tasks ? pick(c.tasks.database, [c.tasks.date, c.tasks.assignee]) : null,
    members: c.me ? pick(c.me.database, [c.me.email]) : null,
    me: null,
  };
  if (out.members) {
    const rows = await queryAll(env, out.members, { filter: { property: c.me.email, email: { equals: c.me.value } } }, 5);
    out.me = rows[0]?.id || null;
  }
  await env.FILES.put(K.ids, JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return out;
}

// "2026-10-24T17:00:00.000+02:00" → { date, time } en hora de Madrid; "2026-10-24" → { date, time: null }
function madrid(s) {
  if (!s) return null;
  if (!s.includes("T")) return { date: s.slice(0, 10), time: null };
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(s)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const plusHour = (t) => `${String(Math.min(23, +t.slice(0, 2) + 1)).padStart(2, "0")}:${t.slice(3)}`;

/** Eventos de Notion, uno por día: { id, uid, title, type, date, start, end, allDay, url }. */
export async function fetchEvents(env) {
  if (!notionOn(env) || !cfg().events) return [];
  const c = cfg().events;
  const { events: id } = await ids(env);
  if (!id) return [];
  const since = addDays(new Date().toISOString().slice(0, 10), -PAST_DAYS);
  const rows = await queryAll(env, id, {
    filter: { and: [
      { property: c.date, date: { on_or_after: since } },
      { or: c.types.map((t) => ({ property: c.type, select: { equals: t } })) },
    ] },
  });
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const d = r.properties[c.date]?.date;
    const title = titleOf(r);
    if (!d?.start || !title) continue;
    const key = `${norm(title)}|${d.start.slice(0, 10)}`;
    if (seen.has(key)) continue; // la misma fila repetida ("Start Day" / "StartDay")
    seen.add(key);
    const a = madrid(d.start), b = madrid(d.end);
    const base = { id: r.id, title, type: r.properties[c.type]?.select?.name || null, url: r.url };
    if (a.time && (!b || b.date === a.date)) {
      out.push({ ...base, uid: `notion-${r.id}`, date: a.date, start: a.time, end: b?.time && b.time > a.time ? b.time : plusHour(a.time), allDay: false });
    } else {
      const last = b?.date && b.date > a.date ? b.date : a.date;
      for (let day = a.date, n = 0; day <= last && n < 31; day = addDays(day, 1), n++) {
        out.push({ ...base, uid: `notion-${r.id}-${day}`, date: day, allDay: true });
      }
    }
  }
  await env.FILES.put(K.events, JSON.stringify(out));
  return out;
}

/** Lo último que se leyó (sin red), para la agenda. */
export async function cachedEvents(env) {
  if (!cfg()?.events) return [];
  return (await env.FILES.get(K.events, { type: "json" })) || [];
}

// ---------- tareas asignadas a ti ----------

const PRIORITY = (p) => ({ alta: "urgente" }[norm(p)] || "normal");

const notify = (env, text, id) => tg(env, "sendMessage", {
  chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 4000), reply_markup: itemKeyboard(id, "tarea"), link_preview_options: { is_disabled: true },
});

/** Cron: tareas tuyas de Notion → tareas de taskbot (source notion:<id>), con hueco y aviso. */
export async function syncNotionTasks(env) {
  if (!notionOn(env) || !cfg().tasks) return;
  const c = cfg().tasks;
  const { tasks: id, me } = await ids(env);
  if (!id || !me) return;
  const rows = await queryAll(env, id, { filter: { property: c.assignee, relation: { contains: me } } });
  for (const r of rows) {
    const title = titleOf(r);
    if (!title) continue;
    const source = `notion:${r.id}`;
    const done = (c.done || []).map(norm).includes(norm(r.properties[c.status]?.status?.name || r.properties[c.status]?.select?.name));
    const due = madrid(r.properties[c.date]?.date?.start);
    const item = await env.DB.prepare("SELECT * FROM items WHERE source=?").bind(source).first();
    if (!item) {
      if (done) continue;
      const res = await env.DB.prepare(
        "INSERT INTO items (kind, text, category, priority, due_date, source, url) VALUES ('tarea', ?, ?, ?, ?, ?, ?)"
      ).bind(title, cfg().category || null, PRIORITY(r.properties[c.priority]?.select?.name), due?.date || null, source, r.url).run();
      const newItem = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(res.meta.last_row_id).first();
      const where = await placeTask(env, newItem);
      await notify(env, `📌 Nueva tarea en ${cfg().name}: ${title}${due ? `\n📅 vence ${due.date}${due.time ? ` ${due.time}` : ""}` : ""}${where}\n${r.url}`, newItem.id);
      continue;
    }
    if (done && item.status !== "hecha") {
      await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(item.id).run();
    } else if (!done && due?.date && due.date !== item.due_date) {
      await env.DB.prepare("UPDATE items SET due_date=? WHERE id=?").bind(due.date, item.id).run();
      await notify(env, `📅 Cambia la fecha en ${cfg().name}: ${title}\nAhora vence el ${due.date}`, item.id);
    }
  }
}

// ---------- conocimiento: buscar y leer páginas ----------

async function pageText(env, pageId, limit = 3500) {
  const lines = [];
  let cursor;
  do {
    const j = await api(env, `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of j.results) {
      const rt = b[b.type]?.rich_text;
      if (rt?.length) lines.push(`${b.type.startsWith("heading") ? "## " : b.type.includes("list") ? "• " : b.type === "to_do" ? (b.to_do.checked ? "☑ " : "☐ ") : ""}${txt(rt)}`);
      else if (b.type === "child_page") lines.push(`(subpágina: ${b.child_page.title})`);
      else if (b.type === "child_database") lines.push(`(base de datos: ${b.child_database.title})`);
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && lines.join("\n").length < limit);
  return lines.join("\n").slice(0, limit);
}

// Campos de una fila de base de datos, legibles (fechas, estado, tipo…).
function propsText(page) {
  const out = [];
  for (const [k, p] of Object.entries(page.properties || {})) {
    let v = "";
    if (p.type === "date" && p.date) v = `${p.date.start}${p.date.end ? ` → ${p.date.end}` : ""}`;
    else if (p.type === "select") v = p.select?.name || "";
    else if (p.type === "status") v = p.status?.name || "";
    else if (p.type === "multi_select") v = p.multi_select.map((x) => x.name).join(", ");
    else if (p.type === "rich_text") v = txt(p.rich_text).slice(0, 300);
    else if (p.type === "people") v = p.people.map((x) => x.name).join(", ");
    else if (p.type === "formula") v = String(p.formula?.string ?? p.formula?.number ?? "");
    if (v) out.push(`${k}: ${v}`);
  }
  return out.join(" · ");
}

/** Herramienta del asistente: busca en Notion y devuelve las páginas más relevantes con su texto. */
export async function searchNotion(env, query) {
  if (!notionOn(env)) return { error: "Notion no está conectado." };
  const { results } = await api(env, "/search", { query: String(query).slice(0, 200), page_size: 8, filter: { property: "object", value: "page" } });
  const pages = results.slice(0, 4);
  if (!pages.length) return { resultados: [], nota: "Nada en Notion con esas palabras: prueba con otras." };
  const out = [];
  for (const p of pages) {
    let texto = "";
    try { texto = await pageText(env, p.id, out.length ? 1500 : 3500); } catch (e) { texto = `(no se pudo leer: ${e.message})`; }
    out.push({ titulo: titleOf(p) || "(sin título)", url: p.url, editada: p.last_edited_time?.slice(0, 10), campos: propsText(p), texto });
  }
  return { espacio: cfg().name, resultados: out };
}
