// Exámenes: se guardan como items (kind='examen') desde Telegram.
// En el calendario de clases, un examen sustituye a la clase de su asignatura que coincide en hora,
// para que no salgan dos eventos a la vez.

import { UC3M_CONFIG } from "./uc3m.js";

export async function loadExams(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_date, start_at, end_at, location FROM items WHERE kind='examen' ORDER BY due_date"
  ).all();
  return results;
}

const norm = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ¿El texto del examen habla de esta asignatura? (por nombre o por cómo la llamas tú)
export function examIsFor(examText, subjectName) {
  const text = ` ${norm(examText).replace(/[^a-z0-9]+/g, " ")} `;
  const subject = Object.values(UC3M_CONFIG.subjects).find((s) => s.name === subjectName);
  const names = [subjectName, ...(subject?.alias || [])].map((n) => norm(n).replace(/[^a-z0-9]+/g, " ").trim());
  return names.some((n) => n && text.includes(` ${n} `));
}

// Clases que un examen deja sin efecto: mismo día, se solapan en hora y son de su asignatura.
export function replacedBy(exam, sessions) {
  if (!exam.start_at) return [];
  const date = exam.start_at.slice(0, 10), start = exam.start_at.slice(11, 16), end = exam.end_at.slice(11, 16);
  return sessions.filter((s) => s.date === date && s.start < end && start < s.end && examIsFor(exam.text, s.subject));
}

// Clases + exámenes para el calendario de clases, sin duplicados.
export function mergeExams(sessions, exams) {
  const gone = new Set();
  const examEvents = exams.map((x) => {
    const replaced = replacedBy(x, sessions);
    replaced.forEach((s) => gone.add(s.key));
    const base = { uid: `exam-${x.id}`, summary: `📝 ${x.text}` };
    // Si la UC3M ha puesto una sesión de recuperación a esa hora, el examen suele ser ahí.
    const room = x.location || (replaced.find((s) => s.type === "RECUPERACIÓN") || replaced[0])?.room;
    const location = room ? (room === "Virtual" ? "Virtual" : `Aula ${room} · UC3M Leganés`) : null;
    if (!x.start_at) return { ...base, date: x.due_date, allDay: true };
    return {
      ...base, location, alarmMin: 24 * 60,
      date: x.start_at.slice(0, 10), start: x.start_at.slice(11, 16), end: x.end_at.slice(11, 16),
    };
  });
  return { sessions: sessions.filter((s) => !gone.has(s.key)), examEvents };
}
