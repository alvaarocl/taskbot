// Lo fijo (clases UC3M + rutina) ya ajustado con lo que llega por Telegram:
// - exámenes: sustituyen a la clase de su asignatura que coincide en hora
// - cancelaciones ("este sábado no hay partido"): quitan ese partido, entreno o clase
// - un evento que pisa un bloque provisional (los partidos) lo sustituye
// Los calendarios suscritos son de solo lectura en Apple, así que estos cambios se hacen aquí.

import { loadSessions } from "./sync.js";
import { routineEvents } from "./rutina.js";
import { loadExams, mergeExams, examIsFor } from "./exams.js";

const norm = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const ROUTINE_WORDS = {
  partido: ["partido", "partidos", "jornada"],
  entreno: ["entreno", "entrenos", "entrenamiento", "entrenamientos"],
  todo: ["baloncesto", "basket", "basquet"],
};

// ¿Esta cancelación quita este evento de la rutina?
function cancelsRoutine(target, ev) {
  const t = ` ${norm(target).replace(/[^a-z0-9]+/g, " ")} `;
  const has = (words) => words.some((w) => t.includes(` ${w} `));
  if (has(ROUTINE_WORDS.todo)) return true;
  if (has(ROUTINE_WORDS.partido)) return norm(ev.summary).includes("partido");
  if (has(ROUTINE_WORDS.entreno)) return norm(ev.summary).includes("entreno");
  return false;
}

export async function loadCancellations(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_date FROM items WHERE kind='cancelacion' AND due_date IS NOT NULL"
  ).all();
  return results;
}

async function loadTimedEvents(env, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT id, start_at, end_at FROM items WHERE kind='evento' AND status='pendiente'
     AND start_at IS NOT NULL AND substr(start_at,1,10) BETWEEN ? AND ?`
  ).bind(from, to).all();
  return results;
}

// Devuelve { sessions, routine, examEvents } entre `from` y `to` (incluidos).
export async function fixedAgenda(env, from = "0000-00-00", to = "9999-99-99") {
  const inRange = (d) => d >= from && d <= to;
  const [allSessions, exams, cancels, events] = await Promise.all([
    loadSessions(env), loadExams(env), loadCancellations(env), loadTimedEvents(env, from, to),
  ]);
  const { sessions, examEvents } = mergeExams(allSessions.filter((s) => inRange(s.date)), exams);
  const byDate = (list, d) => list.filter((c) => c.due_date === d);

  const keptSessions = sessions.filter((s) =>
    !byDate(cancels, s.date).some((c) => examIsFor(c.text, s.subject)));

  const routine = routineEvents().filter((r) => {
    if (!inRange(r.date)) return false;
    if (byDate(cancels, r.date).some((c) => cancelsRoutine(c.text, r))) return false;
    // Un evento con hora real (p. ej. "partido a las 11") sustituye al bloque provisional.
    if (r.tentative && events.some((e) => e.start_at.slice(0, 10) === r.date &&
      e.start_at.slice(11, 16) < r.end && r.start < e.end_at.slice(11, 16))) return false;
    return true;
  });

  return { sessions: keptSessions, routine, examEvents: examEvents.filter((e) => inRange(e.date)) };
}

// Lo que quitaría una cancelación, para contárselo al usuario al guardarla.
export async function cancellationEffect(env, target, date) {
  const sessions = (await loadSessions(env)).filter((s) => s.date === date && examIsFor(target, s.subject));
  const routine = routineEvents().filter((r) => r.date === date && cancelsRoutine(target, r));
  return [
    ...routine.map((r) => `${r.summary} ${r.start}–${r.end}`),
    ...sessions.map((s) => `📚 ${s.subject} ${s.start}–${s.end}`),
  ];
}
