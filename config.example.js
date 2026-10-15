// Configuración personal de taskbot.
// Cópialo a config.js (que no se sube a git) y ajústalo a ti:
//   cp config.example.js config.js
// Cada bloque es un módulo. Los opcionales se apagan poniéndolos a null (o borrándolos).

export default {
  // Quién eres: lo usa el asistente de Telegram (src/agent.js) para entender lo que le mandas.
  assistant: {
    name: "Tu nombre",
    about: "qué estudias o a qué te dedicas, dónde, y qué haces fuera (deporte, proyectos…) en una frase",
    categories: ["uni", "trabajo", "deporte", "personal"], // cómo agrupas lo que apuntas (el panel lo divide así)
    termStart: "2026-09-07", // lunes de la semana 1 del curso, para entender "la semana 6"; null si no aplica
  },

  // OPCIONAL, solo estudiantes de la UC3M: horario leído de la web pública aplicaciones.uc3m.es/horarios-web.
  // Los números de plan, centro y grupo salen de la URL de tu horario en esa web. Si no es tu caso: uc3m: null.
  // Las asignaturas (subjects) también sirven para agrupar tareas y entender "el parcial de SO".
  uc3m: {
    label: "UC3M", // nombre de los calendarios: "UC3M · Clases", "UC3M · Exámenes"
    campus: "UC3M Leganés", // se añade al aula en el calendario
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

  // OPCIONAL: tu Moodle (en la UC3M se llama Aula Global). Necesita el secreto AULAGLOBAL_TOKEN (ver DEPLOY.md).
  // Entregas → tareas, recordatorios, avisos de profesores, material, notas y "¿qué toca mañana en X?".
  aulaGlobal: {
    name: "Aula Global", // cómo se llama tu Moodle en los mensajes
    site: "https://aulaglobal.uc3m.es", // URL de tu Moodle
    year: "26/27", // solo se miran las asignaturas cuyo nombre contiene esto ("… 26/27-1C"); "" = todas
  },

  calendar: {
    uidDomain: "taskbot.example.workers.dev", // dominio de tu worker; fíjalo una vez y no lo cambies
  },

  // Panel web (src/auth.js): su dominio es el RP ID de las passkeys. Fíjalo una vez; si cambia, hay que volver a registrarlas.
  panel: {
    origin: "https://panel.example.com",
    inbox: false, // pestaña Reuniones: mensajes y reservas que empuja otro worker tuyo (ver src/inbox.js)
  },

  // Resumen semanal del domingo (src/weekly.js): commits tuyos y de la organización (secreto GITHUB_TOKEN, solo lectura).
  weekly: {
    github: "tu-usuario", // tu usuario de GitHub
    orgs: ["tu-organizacion"], // organizaciones cuyos commits (de todo el equipo) entran en el resumen
    maxRepos: 6, // repos con actividad que se miran por organización (cada uno es una petición)
  },

  // OPCIONAL: un espacio de Notion (secreto NOTION_TOKEN, ver DEPLOY.md). Solo lee. Pon aquí los nombres de TUS bases
  // y campos; cualquier parte (events, tasks, me) se puede quitar. Apagado: notion: null.
  //   events → filas con fecha cuyo tipo es un evento: calendario /cal/notion.ics y tu agenda
  //   tasks  → las que tienen tu fila de `me` en el campo de asignación: tareas de taskbot
  //   y el asistente busca y lee páginas de ese Notion para responderte.
  notion: null,
  // notion: {
  //   name: "Mi asociación", category: "asociacion",
  //   events: { database: "Proyectos", date: "Fecha límite", type: "Tipo", types: ["Evento", "Evento interno"] },
  //   tasks: { database: "Tareas", date: "Fecha límite", assignee: "Asociado", status: "Estado", done: ["Completada"], priority: "Prioridad" },
  //   me: { database: "Miembros", email: "Correo", value: "tu@correo.com" },
  // },

  // OPCIONAL: Jarvis te llama por Telegram (desde una segunda cuenta tuya) a la hora de despertarte y te cuenta el
  // día. Necesita un repo PRIVADO de GitHub que hace la llamada (ver jarvis/ y DEPLOY.md). Apagado: jarvis: null.
  jarvis: null,
  // jarvis: {
  //   repo: "tu-usuario/jarvis", workflow: "call.yml", voice: "es-ES-AlvaroNeural",
  //   modalUrl: "https://TU-USUARIO--jarvis-start.us-east.modal.run", // opcional: voz natural en Modal (ver jarvis/modal_app.py)
  //   location: { name: "Madrid", lat: 40.4168, lon: -3.7038 }, // para el tiempo
  // },

  // OPCIONAL: tu correo → avisos y tareas. Cloudflare Email Routing manda al worker lo que llega a `address` y tus
  // cuentas (Gmail, la de la uni…) reenvían ahí. Solo se aceptan correos reenviados por `forwarders`. La IA es muy
  // selectiva y nunca apunta nada sin que pulses el botón. Cómo configurarlo, en DEPLOY.md. Apagado: mail: null.
  mail: null,
  // mail: {
  //   address: "bandeja@tudominio.com",
  //   forwarders: ["tu@gmail.com"], // cuentas que reenvían (Gmail reenvía como tu+caf_…@gmail.com: vale igual)
  //   watch: ["uc3m.es"], // dominios que siempre mira la IA, aunque parezcan boletines (listas de la universidad)
  //   ignore: ["aulaglobal"], // remitentes que nunca mira (lo que ya avisa otro módulo)
  // },

  // OPCIONAL: chequeo de salud. Cada noche comprueba que todo lo conectado funciona y solo te escribe si algo falla.
  // /salud lo hace en el momento. Apagado: health: null.
  health: { hour: 21 },

  // OPCIONAL: cierre del día. Por la noche te dice qué ha quedado pendiente y lo pasas a mañana con un botón.
  // Apagado: evening: null.
  evening: { hour: 22 },

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
