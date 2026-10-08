// Rutina semanal fija (baloncesto) generada para toda la temporada, saltando festivos y vacaciones.
// Para cambiar un horario, edita `routine` en config.js y despliega: el calendario suscrito se actualiza solo.
// Para quitar un día suelto ("este sábado no hay partido") no hace falta tocar esto: se dice por Telegram.

import config from "../config.js";

// Horario, festivos y vacaciones: `routine` en config.js.
export const ROUTINE = config.routine;

export function routineEvents(r = ROUTINE) {
  const off = new Set(r.holidays);
  const inBreak = (d) => r.breaks.some((b) => d >= b.from && d <= b.to);
  const out = [];
  const end = new Date(r.season.to + "T00:00:00Z");
  for (let d = new Date(r.season.from + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    if (off.has(date) || inBreak(date)) continue;
    const dow = d.getUTCDay();
    for (const s of r.slots) {
      if (s.day !== dow || (s.from && date < s.from)) continue;
      out.push({
        uid: `rutina-${date}-${s.start.replace(":", "")}`,
        date, start: s.start, end: s.end,
        summary: s.title, description: s.notes, tentative: !!s.tentative,
      });
    }
  }
  return out;
}
