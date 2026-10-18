// El "cerebro": junta clases, rutina, eventos y bloques de tareas en una sola agenda,
// calcula los huecos libres y coloca cada tarea en uno de ellos.
// Todas las horas son locales de Madrid: fechas "YYYY-MM-DD" y horas "HH:MM".

import config from "../config.js";
import { externalBusy } from "./calendar-bridge.js";
import { splitInterval } from "./time.js";
import { typeLabel } from "./sync.js";
import { fixedAgenda } from "./overrides.js";
import { cachedEvents } from "./notion.js";

export const PREFS = config.prefs;

const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

export function nowMadrid() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
  const [date, time] = parts.split(" ");
  return { date, time };
}

export const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayLabel(date) {
  const d = new Date(date + "T00:00:00Z");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

const isWeekend = (date) => [0, 6].includes(new Date(date + "T00:00:00Z").getUTCDay());

// Todo lo que ocupa tiempo entre `from` y `to` (incluidos). `skipId`: no contar el bloque de esa tarea.
export async function loadBusy(env, from, to, skipId = null, includeExternal = true) {
  const busy = [];
  const campus = new Map(); // fecha → [primera hora, última hora] de clase presencial
  const fixed = await fixedAgenda(env, from, to);
  for (const x of fixed.examEvents) {
    const itemId = Number(x.uid.replace("exam-", ""));
    if (x.allDay || itemId === skipId) continue;
    busy.push({ date: x.date, start: x.start, end: x.end, label: x.summary, where: x.location?.replace(/^Aula /, "").replace(/ · .*$/, ""), fixed: true, itemId });
  }
  for (const s of fixed.sessions) {
    busy.push({ date: s.date, start: s.start, end: s.end, label: `📚 ${s.subject} · ${typeLabel(s.type)}`, where: s.room });
    if (s.room === "Virtual") continue;
    const [a, b] = campus.get(s.date) || [s.start, s.end];
    campus.set(s.date, [s.start < a ? s.start : a, s.end > b ? s.end : b]);
  }
  for (const [date, [a, b]] of campus) {
    busy.push({ date, start: fromMin(Math.max(0, toMin(a) - PREFS.commute)), end: a, label: "🚗 Viaje", hidden: true });
    busy.push({ date, start: b, end: fromMin(Math.min(toMin(b) + PREFS.commute, 24 * 60 - 1)), label: "🚗 Viaje", hidden: true });
  }
  for (const r of fixed.routine) {
    const travel = isWeekend(r.date) ? 0 : PREFS.travelBeforeRoutine;
    busy.push({
      date: r.date, start: fromMin(Math.max(0, toMin(r.start) - travel)),
      end: fromMin(Math.min(toMin(r.end) + PREFS.afterRoutine, 24 * 60 - 1)),
      label: r.summary, shown: r.start, shownEnd: r.end,
    });
  }
  // Eventos de Notion (lo último leído, sin red): con hora ocupan ese hueco; de día entero solo se ven (soft).
  const notionName = config.notion?.name || "Notion";
  for (const e of await cachedEvents(env)) {
    if (e.date < from || e.date > to) continue;
    busy.push(e.allDay
      ? { date: e.date, start: "00:00", end: "23:59", allDay: true, soft: true, label: `🚀 ${e.title}`, where: notionName }
      : { date: e.date, start: e.start, end: e.end, label: `🚀 ${e.title}`, where: notionName, fixed: true });
  }
  // Días completos (p. ej. una hackathon sin horario): ocupan la jornada entera.
  const allDay = await env.DB.prepare(
    `SELECT id, text, due_date, location, tbc FROM items
     WHERE status='pendiente' AND kind='evento' AND all_day=1 AND start_at IS NULL AND due_date BETWEEN ? AND ?`
  ).bind(from, to).all();
  for (const it of allDay.results) {
    busy.push({
      date: it.due_date, start: "00:00", end: "23:59", allDay: true, tbc: !!it.tbc,
      label: `📅 ${it.text}${it.tbc ? " (horario por confirmar)" : ""}`, where: it.location, itemId: it.id, fixed: true,
    });
  }
  const { results } = await env.DB.prepare(
    `SELECT id, kind, text, start_at, end_at, location FROM items
     WHERE status='pendiente' AND kind IN ('tarea','evento') AND start_at IS NOT NULL AND substr(start_at,1,10) BETWEEN ? AND ?`
  ).bind(from, to).all();
  for (const it of results) {
    if (it.id === skipId) continue;
    busy.push({
      date: it.start_at.slice(0, 10), start: it.start_at.slice(11, 16), end: it.end_at.slice(11, 16),
      label: `${it.kind === "evento" ? "📅" : "🧠"} ${it.text}`, where: it.location, itemId: it.id,
      fixed: it.kind === "evento",
    });
  }
  // Las reservas son eventos operativos, no solo mensajes del panel.
  const meetings = await env.DB.prepare("SELECT * FROM inbox WHERE kind='reunion' AND status != 'cancelada' AND end_at > ? AND start_at < ?")
    .bind(addDays(from,-1)+'T00:00:00Z', addDays(to,2)+'T00:00:00Z').all();
  for (const meeting of meetings.results) {
    busy.push(...splitInterval(Date.parse(meeting.start_at), Date.parse(meeting.end_at), `📞 ${meeting.name || 'Reunión'}${meeting.topic ? ' · '+meeting.topic : ''}`));
  }
  if (includeExternal) {
    for (const block of await externalBusy(env, from, to)) {
      if (!busy.some(b=>b.date===block.date && (b.shown||b.start)===block.start && (b.shownEnd||b.end)===block.end)) busy.push(block);
    }
  }
  return busy.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// Huecos libres de un día, en minutos. `notBefore`: minuto a partir del cual cuenta (hoy = ahora).
export function freeSlots(busy, date, notBefore = 0) {
  const [ws, we] = PREFS.window[isWeekend(date) ? "weekend" : "weekday"];
  const blocks = busy.filter((b) => b.date === date && !b.soft).map((b) => [toMin(b.start), toMin(b.end)]);
  if (!isWeekend(date)) blocks.push([toMin(PREFS.lunch[0]), toMin(PREFS.lunch[1])]);
  blocks.sort((a, b) => a[0] - b[0]);

  const out = [];
  let cur = Math.max(toMin(ws), roundUp(notBefore));
  for (const [s, e] of blocks) {
    if (s > cur) out.push([cur, Math.min(s, toMin(we))]);
    cur = Math.max(cur, e);
  }
  if (cur < toMin(we)) out.push([cur, toMin(we)]);
  return out.filter(([s, e]) => e - s >= PREFS.minSlot);
}

const roundUp = (m) => Math.ceil(m / 15) * 15;

// Primer hueco donde cabe `duration` minutos, desde `after` ({date, time}) hasta `until` (fecha).
export function findSlot(busy, duration, after, until) {
  for (let date = after.date; date <= until; date = addDays(date, 1)) {
    const notBefore = date === after.date ? toMin(after.time) : 0;
    for (const [s, e] of freeSlots(busy, date, notBefore)) {
      if (e - s >= duration) return { date, start: fromMin(s), end: fromMin(s + duration) };
    }
  }
  return null;
}

// Coloca una tarea en el primer hueco antes de su fecha límite y lo guarda.
// Devuelve { slot, late }: late = no cabía antes de la fecha límite y va después.
export async function scheduleTask(env, item, after = null) {
  const now = nowMadrid();
  const from = after && after.date + after.time > now.date + now.time ? after : now;
  const duration = item.duration_min || PREFS.defaultTaskMin;
  const horizon = addDays(from.date, PREFS.horizonDays);
  const until = item.due_date && item.due_date < horizon ? item.due_date : horizon;
  const busy = await loadBusy(env, from.date, addDays(horizon,7), item.id);
  const deadlineBlock=item.due_at ? {date:item.due_at.slice(0,10),start:item.due_at.slice(11,16),end:'24:00'} : null;
  let slot = findSlot(deadlineBlock?[...busy,deadlineBlock]:busy, duration, from, until);
  let late = false;
  if (!slot && item.due_date) {
    slot = findSlot(busy, duration, from, addDays(horizon,7));
    late = !!slot;
  }
  if (!slot) {
    await env.DB.prepare('UPDATE items SET start_at=NULL,end_at=NULL WHERE id=?').bind(item.id).run();
    return { slot: null, late };
  }
  await env.DB.prepare("UPDATE items SET start_at=?, end_at=? WHERE id=?")
    .bind(`${slot.date}T${slot.start}`, `${slot.date}T${slot.end}`, item.id).run();
  return { slot, late };
}

// Lo que choca con un evento nuevo (para avisar al crearlo).
export async function conflictsFor(env, date, start, end, skipId) {
  const busy = await loadBusy(env, date, date, skipId);
  return busy.filter((b) => !b.hidden && (b.shown || b.start) < end && start < (b.shownEnd || b.end));
}

// La agenda de un día, estructurada: bloques visibles y huecos libres (hoy, desde ahora). La usan /hoy y el panel.
export async function agendaData(env, date) {
  const busy = await loadBusy(env, date, date);
  const now = nowMadrid();
  const blocks = busy.filter((b) => !b.hidden).map((b) => ({
    start: b.shown || b.start, end: b.shownEnd || b.end, label: b.label,
    where: b.where || null, itemId: b.itemId ?? null, fixed: !!b.fixed, allDay: !!b.allDay,
  }));
  const free = freeSlots(busy, date, date === now.date ? toMin(now.time) : 0)
    .map(([s, e]) => ({ start: fromMin(s), end: fromMin(e) }));
  return { date, label: dayLabel(date), blocks, free };
}

export async function agendaText(env, date) {
  const { blocks, free } = await agendaData(env, date);
  const lines = blocks.map((b) => `${b.allDay ? "Todo el día" : `${b.start}–${b.end}`} ${b.label}${b.where ? ` (${b.where})` : ""}`);
  return `🗓 ${dayLabel(date)}\n` +
    (lines.length ? lines.join("\n") : "Nada fijo") +
    `\n\n🟢 Libre: ${free.length ? free.map((f) => `${f.start}–${f.end}`).join(", ") : "nada"}`;
}

export async function weekFreeText(env) {
  const now = nowMadrid();
  const to = addDays(now.date, 6);
  const busy = await loadBusy(env, now.date, to);
  const out = [];
  for (let d = now.date; d <= to; d = addDays(d, 1)) {
    const free = freeSlots(busy, d, d === now.date ? toMin(now.time) : 0);
    const total = free.reduce((n, [s, e]) => n + e - s, 0);
    out.push(`${dayLabel(d)} · ${Math.round(total / 6) / 10} h\n   ${free.map(([s, e]) => `${fromMin(s)}–${fromMin(e)}`).join(", ") || "—"}`);
  }
  return `🟢 Huecos libres (7 días)\n\n${out.join("\n")}`;
}
