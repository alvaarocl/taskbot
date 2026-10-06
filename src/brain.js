// El "cerebro": junta clases, rutina, eventos y bloques de tareas en una sola agenda,
// calcula los huecos libres y coloca cada tarea en uno de ellos.
// Todas las horas son locales de Madrid: fechas "YYYY-MM-DD" y horas "HH:MM".

import { typeLabel } from "./sync.js";
import { fixedAgenda } from "./overrides.js";

export const PREFS = {
  window: { weekday: ["08:00", "22:00"], weekend: ["10:00", "21:00"] }, // horas en las que se puede planificar
  lunch: ["14:00", "14:30"], // entre semana
  travelBeforeRoutine: 30, // minutos de viaje antes de cada entreno
  afterRoutine: 15, // margen al acabar el entreno
  commute: 30, // viaje antes de la primera clase y después de la última
  minSlot: 30, // un hueco más corto no cuenta
  defaultTaskMin: 45,
  horizonDays: 14, // tareas sin fecha: dentro de las próximas 2 semanas
};

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
export async function loadBusy(env, from, to, skipId = null) {
  const busy = [];
  const campus = new Map(); // fecha → [primera hora, última hora] de clase presencial
  const fixed = await fixedAgenda(env, from, to);
  for (const x of fixed.examEvents) {
    const itemId = Number(x.uid.replace("exam-", ""));
    if (x.allDay || itemId === skipId) continue;
    busy.push({ date: x.date, start: x.start, end: x.end, label: x.summary, where: x.location?.replace(/^Aula | · UC3M Leganés$/g, ""), fixed: true, itemId });
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
  return busy.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// Huecos libres de un día, en minutos. `notBefore`: minuto a partir del cual cuenta (hoy = ahora).
export function freeSlots(busy, date, notBefore = 0) {
  const [ws, we] = PREFS.window[isWeekend(date) ? "weekend" : "weekday"];
  const blocks = busy.filter((b) => b.date === date).map((b) => [toMin(b.start), toMin(b.end)]);
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
  const horizon = addDays(now.date, PREFS.horizonDays);
  const until = item.due_date && item.due_date >= from.date ? item.due_date : horizon;
  const busy = await loadBusy(env, from.date, addDays(until > horizon ? until : horizon, 7), item.id);

  let slot = findSlot(busy, duration, from, until);
  let late = false;
  if (!slot && item.due_date) {
    slot = findSlot(busy, duration, from, addDays(until, 7));
    late = !!slot;
  }
  if (!slot) return { slot: null, late };
  await env.DB.prepare("UPDATE items SET start_at=?, end_at=? WHERE id=?")
    .bind(`${slot.date}T${slot.start}`, `${slot.date}T${slot.end}`, item.id).run();
  return { slot, late };
}

// Lo que choca con un evento nuevo (para avisar al crearlo).
export async function conflictsFor(env, date, start, end, skipId) {
  const busy = await loadBusy(env, date, date, skipId);
  return busy.filter((b) => !b.hidden && (b.shown || b.start) < end && start < (b.shownEnd || b.end));
}

// Recoloca bloques de tareas que se han pasado o que ahora chocan con algo fijo.
export async function replan(env) {
  const now = nowMadrid();
  const { results } = await env.DB.prepare(
    "SELECT * FROM items WHERE status='pendiente' AND kind='tarea' AND start_at IS NOT NULL ORDER BY start_at"
  ).all();
  const moves = [];
  for (const it of results) {
    const date = it.start_at.slice(0, 10), start = it.start_at.slice(11, 16), end = it.end_at.slice(11, 16);
    const missed = it.end_at < `${now.date}T${now.time}`;
    let reason = missed ? "se pasó" : null;
    if (!missed) {
      const busy = (await loadBusy(env, date, date, it.id)).filter((b) => !b.itemId || b.fixed);
      const hit = busy.find((b) => b.start < end && start < b.end);
      if (hit) reason = `chocaba con ${hit.label}`;
    }
    if (!reason) continue;
    const { slot } = await scheduleTask(env, it);
    moves.push({ item: it, reason, slot });
  }
  return moves;
}

export async function agendaText(env, date) {
  const busy = await loadBusy(env, date, date);
  const now = nowMadrid();
  const lines = busy.filter((b) => !b.hidden)
    .map((b) => `${b.shown || b.start}–${b.shownEnd || b.end} ${b.label}${b.where ? ` (${b.where})` : ""}`);
  const free = freeSlots(busy, date, date === now.date ? toMin(now.time) : 0)
    .map(([s, e]) => `${fromMin(s)}–${fromMin(e)}`);
  return `🗓 ${dayLabel(date)}\n` +
    (lines.length ? lines.join("\n") : "Nada fijo") +
    `\n\n🟢 Libre: ${free.length ? free.join(", ") : "nada"}`;
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
