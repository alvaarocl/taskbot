// Rutina semanal fija (baloncesto) generada para toda la temporada, saltando festivos y vacaciones.
// Para cambiar un horario, edita ROUTINE y despliega: el calendario suscrito se actualiza solo.
// Para quitar un día suelto ("este sábado no hay partido") no hace falta tocar esto: se dice por Telegram.

// Calendario: los entrenos siguen al cole. Sin cole = sin entreno.
// Fuentes: Resolución de 24/06/2026 de la Delegación de Educación en Toledo (calendario escolar 2026/27)
// y calendarios laborales de Castilla-La Mancha 2026 (Decreto 44/2025) y 2027 (Decreto 34/2026).
export const ROUTINE = {
  // Las clases en el cole terminan el 22/06/2027.
  season: { from: "2026-09-01", to: "2027-06-22" },
  // 1 = lunes … 6 = sábado
  slots: [
    { day: 1, start: "16:00", end: "18:30", title: "🏀 Entreno", notes: "Psico + Cadete" },
    { day: 2, start: "17:15", end: "20:30", title: "🏀 Entreno", notes: "Alevín + Infantil" },
    { day: 3, start: "16:00", end: "18:30", title: "🏀 Entreno", notes: "Psico + Cadete" },
    { day: 4, start: "17:15", end: "20:30", title: "🏀 Entreno", notes: "Alevín + Infantil" },
    { day: 5, start: "17:00", end: "18:30", title: "🏀 Entreno", notes: "Cadete" },
    // Hora aproximada: los partidos cambian cada jornada. Sin partidos hasta el 7/11 incluido.
    { day: 6, start: "09:30", end: "13:30", title: "🏀 Partidos", notes: "Horario por confirmar según jornada", tentative: true, from: "2026-11-08" },
  ],
  // Días sueltos sin cole (festivos o no lectivos).
  holidays: [
    "2026-10-12", // Fiesta Nacional
    "2026-11-02", // Todos los Santos (trasladado del domingo 1)
    "2026-11-20", // Día de la Enseñanza
    "2026-12-07", // no lectivo (calendario escolar de Toledo)
    "2026-12-08", // Inmaculada
    "2027-02-08", "2027-02-09", // días de libre disposición (Carnaval)
    "2027-05-01", // Fiesta del Trabajo (sábado: sin partidos)
    "2027-05-27", // Corpus Christi
    "2027-05-28", // no lectivo (calendario escolar de Toledo)
    "2027-05-31", // Día de Castilla-La Mancha
    // Fiestas locales de Valmojado 2027: el BOP las publica hacia mediados de octubre de 2026
    // (en 2026 fueron el 4 de mayo y el 7 de agosto). Añadirlas aquí cuando salgan.
  ],
  // Descansos escolares.
  breaks: [
    { from: "2026-12-23", to: "2027-01-08", name: "Navidad" },
    { from: "2027-03-22", to: "2027-03-29", name: "Semana Santa" },
  ],
};

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
