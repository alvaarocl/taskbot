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
  if (cursor) throw new Error("Notion: resultado incompleto; no se reconcilian tareas.");
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
  if (!id || !me) throw new Error("Notion: no se encuentra la base o tu miembro; revisa los permisos.");
  const rows = await queryAll(env, id, { filter: { property: c.assignee, relation: { contains: me } } });
  const seen = new Set();
  for (const r of rows) {
    seen.add(`notion:${r.id}`);
    await reconcileNotionPage(env, r, c);
  }
  // Verificar ausentes en origen: nunca retirarlos solo porque una consulta fue parcial o falló.
  const { results: existing } = await env.DB.prepare("SELECT * FROM items WHERE source LIKE 'notion:%' AND status != 'retirada'").all();
  const missing = existing.filter((it) => !seen.has(it.source));
  const offset = Number(await env.FILES.get("notion:verify-offset") || 0) % Math.max(1, missing.length);
  const selected = [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, 6);
  for (const item of selected) {
    const r = await api(env, `/pages/${item.source.slice(7)}`);
    const assigned = r.properties?.[c.assignee]?.relation?.some((x) => x.id === me);
    if (r.archived || r.in_trash || !assigned) {
      await env.DB.prepare("UPDATE items SET status='retirada', start_at=NULL, end_at=NULL WHERE id=?").bind(item.id).run();
      await notify(env, `ℹ️ Ya no está asignada a ti o se ha retirado de ${cfg().name}: ${item.text}`, item.id);
    }
  }
  await env.FILES.put("notion:verify-offset", String(offset + selected.length));
}

export function notionTaskFields(r, c) {
  const due = madrid(r.properties[c.date]?.date?.start);
  const done = (c.done || []).map(norm).includes(norm(r.properties[c.status]?.status?.name || r.properties[c.status]?.select?.name));
  return { text: titleOf(r), due_date: due?.date || null, due_at: due?.time ? `${due.date}T${due.time}` : null,
    priority: PRIORITY(r.properties[c.priority]?.select?.name), status: done ? "hecha" : "pendiente", url: r.url || null };
}

async function reconcileNotionPage(env, r, c) {
  const fields = notionTaskFields(r, c);
  if (!fields.text) return;
  const source = `notion:${r.id}`;
  const item = await env.DB.prepare("SELECT * FROM items WHERE source=?").bind(source).first();
  if (!item) {
    if (fields.status === "hecha") return;
    const res = await env.DB.prepare(
      "INSERT INTO items (kind, text, category, priority, due_date, due_at, source, url) VALUES ('tarea', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source) DO NOTHING"
    ).bind(fields.text, cfg().category || null, fields.priority, fields.due_date, fields.due_at, source, fields.url).run();
    if (!res.meta.changes) return;
    const fresh = await env.DB.prepare("SELECT * FROM items WHERE source=?").bind(source).first();
    const where = await placeTask(env, fresh);
    await notify(env, `📌 Nueva tarea en ${cfg().name}: ${fields.text}${fields.due_date ? `\n📅 vence ${fields.due_date}` : ""}${where}\n${fields.url || ""}`, fresh.id);
    return;
  }
  const changed = Object.keys(fields).filter((key) => (item[key] ?? null) !== fields[key]);
  if (!changed.length) return;
  const dueChanged = changed.some((k) => k === "due_date" || k === "due_at");
  const reopened = item.status !== "pendiente" && fields.status === "pendiente";
  await env.DB.prepare(`UPDATE items SET text=?, due_date=?, due_at=?, priority=?, status=?, url=?,
      done_at=CASE WHEN ?='hecha' THEN COALESCE(done_at,datetime('now')) ELSE NULL END,
      start_at=CASE WHEN ?='hecha' THEN NULL ELSE start_at END,
      end_at=CASE WHEN ?='hecha' THEN NULL ELSE end_at END WHERE id=?`)
    .bind(fields.text, fields.due_date, fields.due_at, fields.priority, fields.status, fields.url, fields.status, fields.status, fields.status, item.id).run();
  // Replanificar el bloque si el plazo cambia o la tarea se reabre.
  let where = "";
  if (fields.status === "pendiente" && (dueChanged || reopened)) {
    const fresh = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(item.id).first();
    where = await placeTask(env, fresh);
  }
  await notify(env, `🔄 Cambio en ${cfg().name}: ${fields.text}\n${fields.status === "hecha" ? "Completada en origen" : reopened ? "Vuelve a estar pendiente" : "Datos actualizados"}${fields.due_date ? ` · vence ${fields.due_date}` : " · sin fecha límite"}${where}\n${fields.url || ""}`, item.id);
}

// ---------- conocimiento: buscar y leer páginas ----------

async function pageText(env, pageId, limit = 6000) {
  const lines = []; let calls = 0; let truncated = false;
  const read = async (id, depth = 0) => {
    let cursor;
    do {
      if (calls >= 8 || lines.join("\n").length >= limit || depth > 4) { truncated = true; return; }
      calls++;
      const j = await api(env, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const b of j.results || []) {
        const rt = b[b.type]?.rich_text;
        if (rt?.length) lines.push(`${"  ".repeat(depth)}${b.type === "to_do" ? (b.to_do.checked ? "☑ " : "☐ ") : ""}${txt(rt)}`);
        else if (b.type === "child_page") lines.push(`Subpágina: ${b.child_page.title} (id ${b.id})`);
        else if (b.type === "child_database") lines.push(`Base: ${b.child_database.title}`);
        if (b.has_children) await read(b.id, depth + 1);
      }
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor);
  };
  await read(pageId);
  return lines.join("\n").slice(0, limit) + (truncated ? "\n[Contenido parcial por límite de lectura; no asumir que se ha leído toda la página.]" : "");
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
    try { texto = await pageText(env, p.id, out.length ? 2500 : 6000); } catch (e) { texto = `(no se pudo leer: ${e.message})`; }
    out.push({ titulo: titleOf(p) || "(sin título)", url: p.url, editada: p.last_edited_time?.slice(0, 10), campos: propsText(p), texto });
  }
  return { espacio: cfg().name, resultados: out };
}
