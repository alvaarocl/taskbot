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

  // Asistente de X (src/social.js): avisa y escribe borradores; nunca publica.
  social: {
    // Quién escribe: lo usa la IA para los borradores.
    voice: "TU NOMBRE, a qué te dedicas y de qué sueles hablar (una frase).",
    // Cuándo avisar: un "hay tema para post" cada minHours–maxHours, como mucho maxPerDay al día y nunca
    // entre quiet[0] y quiet[1]. Antes de minHours solo si la IA lo marca urgente (algo gordo) con nota ≥ urgentScore;
    // pasado maxHours basta con lateScore. Notas de 0 a 10.
    cadence: { minHours: 20, maxHours: 44, maxPerDay: 2, quiet: [23, 9], minScore: 7, urgentScore: 8, lateScore: 5 },
    github: { languages: ["", "typescript", "rust", "python", "swift"] }, // "" = todos los lenguajes
    events: { hour: 12, luma: "madrid", meetupKeywords: ["inteligencia artificial", "programación", "startup"] }, // se miran a esa hora; solo avisa de los nuevos
    // news: fuentes de primera mano. Lo importante que publican llega al momento como 🗞 (la IA descarta lo menor)
    // y además sube la temperatura del tema en sus primeras 12 h.
    // type "links": páginas sin RSS; se leen los enlaces que contienen `pattern`.
    feeds: [
      { name: "OpenAI", url: "https://openai.com/news/rss.xml", news: true },
      { name: "Anthropic", url: "https://www.anthropic.com/news", type: "links", pattern: "/news/", news: true },
      { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", news: true },
      { name: "Google Gemini", url: "https://blog.google/products/gemini/rss/", news: true },
      { name: "Claude Code", url: "https://github.com/anthropics/claude-code/releases.atom", news: true },
      { name: "Cursor", url: "https://cursor.com/changelog/rss.xml", news: true },
      { name: "GitHub Changelog", url: "https://github.blog/changelog/feed/", news: true },
      { name: "Qwen", url: "https://qwenlm.github.io/blog/index.xml", news: true },
      { name: "Apple Developer", url: "https://developer.apple.com/news/rss/news.rss", news: true },
      { name: "Rust", url: "https://blog.rust-lang.org/feed.xml", news: true },
      { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
      { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/" },
      { name: "Latent Space", url: "https://www.latent.space/feed" },
      { name: "Cloudflare", url: "https://blog.cloudflare.com/rss/" },
      { name: "Vercel", url: "https://vercel.com/atom" },
      { name: "GitHub", url: "https://github.blog/feed/" },
      { name: "TechCrunch IA", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    ],
  },
};
