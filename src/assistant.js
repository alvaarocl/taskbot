// Piezas que usa el asistente (src/agent.js) y el resto del bot: lo guardado en forma legible, el
// calendario ya resuelto para el modelo, la agenda de varios días y los cambios con ↩️ Deshacer.

import config from "../config.js";
import { hideReferences } from "./presentation.js";
import { loadBusy, freeSlots, findSlot, nowMadrid, addDays, dayLabel, toMin, fromMin, conflictsFor } from "./brain.js";

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// ---------- contexto ----------

// Lo que se puede consultar o cambiar: tareas, eventos y exámenes pendientes, y cancelaciones.
export async function listItems(env, today) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, text, priority, category, due_date, due_at, start_at, end_at, location, url, series, all_day, tbc FROM items
     WHERE (kind IN ('tarea','evento') AND status='pendiente')
        OR kind='examen'
        OR (kind='cancelacion' AND due_date >= ?)
     ORDER BY COALESCE(start_at, due_date, '9999') LIMIT 120`
  ).bind(addDays(today, -7)).all();
  return results;
}

export function describe(i) {
  const when = i.start_at
    ? `${dayLabel(i.start_at.slice(0, 10))} ${i.start_at.slice(11, 16)}–${i.end_at.slice(11, 16)}`
    : i.due_date ? `${dayLabel(i.due_date)}${i.all_day ? ` todo el día${i.tbc ? " (horario por confirmar)" : ""}` : ""}` : "sin fecha";
  const due = i.kind === "tarea" && i.due_date ? ` · vence ${dayLabel(i.due_date)}${i.due_at ? ` ${i.due_at.slice(11)}` : ""}` : "";
  const kind = { tarea: "tarea", evento: "evento", examen: "examen", cancelacion: "cancelación" }[i.kind];
  return `#${i.id} · ${kind} · ${i.text} · ${i.kind === "tarea" ? (i.start_at ? `hueco ${when}` : "sin hueco") : when}${due}${i.series ? ` · serie ${i.series}` : ""}`;
}

// Los modelos fallan calculando "mañana" o "el jueves": se les da el calendario ya resuelto.
export function todayLine(now) {
  const dow = (d) => DAYS[new Date(d + "T12:00:00Z").getUTCDay()];
  const next = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(now.date, i + 1);
    return `${dow(d)} ${d}${i === 0 ? " (mañana)" : i === 1 ? " (pasado mañana)" : ""}`;
  });
  return `Hoy es ${dow(now.date)} ${now.date}, son las ${now.time} (hora de Madrid). ` +
    `Próximos días: ${next.join(", ")}. "El jueves" = el próximo jueves de esa lista.` +
    (config.assistant?.termStart ? ` La semana 1 del curso empezó el lunes ${config.assistant.termStart}.` : "");
}

export async function agendaBlock(env, from, to, now) {
  const busy = await loadBusy(env, from, to);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const lines = busy.filter((b) => b.date === d && !b.hidden)
      .map((b) => `  ${b.allDay ? "todo el día" : `${b.shown || b.start}–${b.shownEnd || b.end}`} ${b.label}${b.where ? ` (${b.where})` : ""}`);
    const free = freeSlots(busy, d, d === now.date ? toMin(now.time) : 0).map(([s, e]) => `${fromMin(s)}–${fromMin(e)}`);
    out.push(`${DAYS[new Date(d + "T12:00:00Z").getUTCDay()]} ${d}:\n${lines.join("\n") || "  (nada)"}\n  libre: ${free.join(", ") || "nada"}`);
  }
  return out.join("\n");
}

// ---------- cambios ----------

export const UNDO = (id) => `undo:${id}`;
export const COLS = ["text", "due_date", "due_at", "start_at", "end_at", "duration_min", "status", "done_at", "all_day", "tbc"];

export async function applyChange(env, item, intent, c) {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(item.id).first();
  await env.FILES.put(UNDO(item.id), JSON.stringify(Object.fromEntries(COLS.map((k) => [k, row[k]]))), { expirationTtl: 2 * 86400 });

  if (intent === "hecho") {
    await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(item.id).run();
    return `✅ Hecho: ${row.text}`;
  }

  const set = {};
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "") ? c.fecha : null;
  const hora = /^\d{2}:\d{2}$/.test(c.hora || "") ? c.hora : null;
  const dur = Number(c.duracion_min) > 0 ? Math.round(Number(c.duracion_min)) : null;
  if (typeof c.titulo === "string" && c.titulo.trim()) set.text = c.titulo.trim().slice(0, 200);

  let extra = "";
  if (row.kind === "tarea" && c.que === "fecha_limite" && fecha) {
    set.due_date = fecha;
    if (row.due_at) set.due_at = `${fecha}T${hora || row.due_at.slice(11)}`;
  } else if (row.kind === "tarea" && (fecha || hora || dur)) {
    // Mover el hueco donde la hace: a esa hora, o al primer hueco libre de ese día.
    const minutes = dur || row.duration_min || (row.start_at ? toMin(row.end_at.slice(11)) - toMin(row.start_at.slice(11)) : 60);
    const day = fecha || row.start_at?.slice(0, 10) || nowMadrid().date;
    if (hora) {
      set.start_at = `${day}T${hora}`;
      set.end_at = `${day}T${fromMin(Math.min(toMin(hora) + minutes, 23 * 60 + 59))}`;
    } else {
      const now = nowMadrid();
      const after = day === now.date ? now : { date: day, time: "00:00" };
      const slot = findSlot(await loadBusy(env, day, day, row.id), minutes, after, day);
      if (slot) {
        set.start_at = `${slot.date}T${slot.start}`;
        set.end_at = `${slot.date}T${slot.end}`;
      } else {
        extra = `\n⚠️ Ese día no tienes ningún hueco libre de ${minutes} min`;
      }
    }
    if (dur) set.duration_min = dur;
  } else if (fecha || hora || dur) {
    // Evento o examen: misma duración salvo que se diga otra.
    const start = row.start_at || `${row.due_date}T${hora || "09:00"}`;
    const minutes = dur || (row.end_at ? toMin(row.end_at.slice(11)) - toMin(start.slice(11)) : 60);
    const day = fecha || start.slice(0, 10);
    const t = hora || start.slice(11, 16);
    if (row.start_at || hora) {
      set.start_at = `${day}T${t}`;
      set.end_at = `${day}T${fromMin(Math.min(toMin(t) + minutes, 23 * 60 + 59))}`;
      if (row.all_day) Object.assign(set, { all_day: 0, tbc: 0 }); // ya tiene hora: deja de ser día completo
    }
    set.due_date = day;
    if (dur) set.duration_min = dur;
  }

  const keys = Object.keys(set);
  if (!keys.length) return `🤔 No he entendido qué cambiar de: ${row.text}`;
  await env.DB.prepare(`UPDATE items SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...keys.map((k) => set[k]), item.id).run();

  const after = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(item.id).first();
  let clash = "";
  if (after.start_at && after.kind !== "tarea") {
    const hits = (await conflictsFor(env, after.start_at.slice(0, 10), after.start_at.slice(11, 16), after.end_at.slice(11, 16), after.id))
      .filter((h) => !(after.kind === "examen" && h.label.startsWith("📚")));
    if (hits.length) clash = `\n⚠️ Choca con: ${hits.map((h) => `${h.label} (${h.shown || h.start}–${h.shownEnd || h.end})`).join(", ")}`;
  }
  const moved = row.kind === "examen" && row.start_at !== after.start_at && row.start_at
    ? `\nEl ${dayLabel(row.start_at.slice(0, 10))} vuelve a salir la clase normal.` : "";
  return `✏️ Cambiado:\n${hideReferences(describe(after))}${moved}${clash}${extra}`;
}

// Botón ↩️ Deshacer.
export async function undoChange(env, id) {
  const prev = await env.FILES.get(UNDO(id), { type: "json" });
  if (!prev) return "Ya no puedo deshacer eso (han pasado más de 2 días).";
  await env.DB.prepare(`UPDATE items SET ${COLS.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...COLS.map((k) => prev[k] ?? null), id).run();
  await env.FILES.delete(UNDO(id));
  return "↩️ Deshecho: vuelve a estar como antes";
}
