// Configuración personal de taskbot.
// Cópialo a config.js (que no se sube a git) y ajústalo a tu matrícula y tu semana:
//   cp config.example.js config.js

export default {
  // Horario de la UC3M, leído de la web pública aplicaciones.uc3m.es/horarios-web.
  // Los números de plan, centro y grupo salen de la URL de tu horario en esa web.
  uc3m: {
    year: 2026, // curso 2026/2027
    plan: 570, // grado (570 = Ingeniería Informática)
    centro: 2, // 2 = EPS Leganés
    // Una página por curso, grupo y cuatrimestre (per: 1 o 2).
    pages: [
      { curso: 2, grupo: 81, per: 1 },
      { curso: 2, grupo: 81, per: 2 },
    ],
    // Asignaturas matriculadas: código → grupo y nombre para el calendario.
    // `alias`: cómo las llamas tú; sirve para saber de qué asignatura es un examen ("parcial de SO").
    subjects: {
      13878: { group: 81, name: "Sistemas Operativos", alias: ["sistemas operativos", "so"] },
      13883: { group: 81, name: "Inteligencia Artificial", alias: ["inteligencia artificial", "ia"] },
    },
    // Asignaturas que no salen en horarios-web (p. ej. humanidades): nombre y fechas.
    fixed: [],
  },

  // Rutina semanal fija (deporte, trabajo…), generada para toda la temporada.
  // Para quitar un día suelto no hace falta tocar esto: se dice por Telegram.
  routine: {
    season: { from: "2026-09-01", to: "2027-06-22" },
    // 1 = lunes … 6 = sábado. `tentative`: hora aproximada. `from`: empieza ese día.
    slots: [
      { day: 2, start: "18:00", end: "19:30", title: "🏃 Entreno", notes: "" },
      { day: 4, start: "18:00", end: "19:30", title: "🏃 Entreno", notes: "" },
    ],
    // Días sueltos sin rutina (festivos).
    holidays: ["2026-10-12", "2026-12-08"],
    // Vacaciones.
    breaks: [
      { from: "2026-12-23", to: "2027-01-08", name: "Navidad" },
    ],
  },

  // Cómo coloca las tareas en los huecos libres.
  prefs: {
    window: { weekday: ["08:00", "22:00"], weekend: ["10:00", "21:00"] }, // horas en las que se puede planificar
    lunch: ["14:00", "14:30"], // entre semana
    travelBeforeRoutine: 30, // minutos de viaje antes de cada bloque de rutina
    afterRoutine: 15, // margen al acabarla
    commute: 30, // viaje antes de la primera clase y después de la última
    minSlot: 30, // un hueco más corto no cuenta
    defaultTaskMin: 45,
    horizonDays: 14, // tareas sin fecha: dentro de las próximas 2 semanas
  },

  aulaGlobal: {
    year: "26/27", // solo se miran las asignaturas de este curso: "… 26/27-1C" / "… 26/27-2C"
  },

  calendar: {
    uidDomain: "taskbot.example.workers.dev", // dominio de tu worker; fíjalo una vez y no lo cambies
  },
};
