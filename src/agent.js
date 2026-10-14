// El asistente personal: un agente con herramientas sobre gpt-oss-120b (src/llm.js).
// Lee el mensaje entero (un texto largo, un email pegado, la info de una hackathon) y apunta, cambia o
// responde usando las mismas piezas que el resto del bot: insertItem, scheduleTask (huecos con tus pautas),
// applyChange (con ↩️ Deshacer) y la agenda real. Si le falta algo imprescindible, pregunta.
//
// Devuelve true si el mensaje queda resuelto; false si el modelo no está disponible y no se ha tocado nada
// (entonces telegram.js lo guarda por el camino de siempre: nunca se pierde un mensaje).

import config from "../config.js";
import { chat, QuotaError } from "./llm.js";
import { enqueue } from "./queue.js";
import { tg, insertItem, placeTask } from "./telegram.js";
import { listItems, describe, todayLine, agendaBlock, applyChange, undoChange, UNDO, COLS } from "./assistant.js";
import { aulaContext, courseOutline } from "./aulaglobal.js";
import { searchNotion } from "./notion.js";
import { conflictsFor, nowMadrid, addDays, dayLabel, toMin, fromMin } from "./brain.js";

const HISTORY = "chat:history";
const HISTORY_TURNS = 12; // mensajes (tuyos y míos) que se recuerdan
const MAX_STEPS = 8;
const MAX_INPUT = 12000; // caracteres de un mensaje (un email largo cabe)
const MAX_SERIES_DAYS = 31;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const okDate = (d) => (DATE.test(d || "") ? d : null);
const okTime = (t) => (TIME.test(t || "") ? t : null);

// ---------- prompt ----------

// Parte estable primero (se cachea en Groq); lo que cambia cada vez va en un segundo mensaje de sistema.
function stablePrompt() {
  const p = config.prefs;
  const subjects = Object.values(config.uc3m?.subjects || {})
    .map((s) => `${s.name}${s.alias?.length ? ` (${s.alias.join(", ")})` : ""}`).join("; ");
  const me = config.assistant || {};
  const moodle = config.aulaGlobal?.name || "Moodle";
  return `Eres el asistente personal de ${me.name || "tu usuario"} en Telegram${me.about ? `: ${me.about}` : ""}. Hablas español de España, cercano y directo.

CÓMO TRABAJAS
- Lee el mensaje ENTERO. Puede ser una frase, un audio transcrito, un email o la descripción de un evento pegada. Saca todo lo que haya que apuntar: eventos, tareas, entregas, exámenes, cancelaciones, notas. Un mensaje puede dar varias cosas.
- Para apuntar, cambiar o consultar usa SIEMPRE las herramientas. Nunca digas que has apuntado o cambiado algo si no has llamado a la herramienta y ha ido bien.
- Fechas: usa SOLO el calendario resuelto que te doy ("el jueves" = el próximo jueves de esa lista). Formato YYYY-MM-DD y horas HH:MM, hora de Madrid. No inventes fechas, horas ni lugares.
- Si falta algo imprescindible (no hay fecha, o no sabes a qué elemento se refiere), PREGUNTA en una frase en vez de suponer. No preguntes lo que puedas resolver tú.
- Evento sin horario conocido (p. ej. una hackathon "del 8 al 12"): créalo igualmente con crear_evento, de día completo y horario_por_confirmar=true, y dile que le preguntarás el horario unos días antes. Esos días no se le colocan tareas.
- Eventos de varios días: crear_evento con fecha y fecha_fin. Si cada día tiene un horario distinto, usa "dias". Cuando te dé el horario de un evento que ya existe (o de una serie), usa fijar_horario con el id; no crees otro.
- Tareas: crear_tarea. El sistema les busca hueco solo, respetando sus pautas: tú no calcules huecos. Si dice cuánto le llevará, pon duracion_min; si no, déjalo vacío.
- Si una entrega se hace DURANTE un evento (p. ej. el proyecto de una hackathon) o es solo una fecha límite que no necesita tiempo aparte, crear_tarea con sin_hueco=true: queda la fecha límite y no se le reserva tiempo.
- Entregas y prácticas de la uni: categoria "uni" y el título con la asignatura: "Entregar: práctica 2 · Nombre de la asignatura".
- Preguntas sobre su agenda, huecos, clases o exámenes: usa ver_agenda (y aula_global para avisos y notas de los profesores en ${moodle}) y responde con las horas EXACTAMENTE como salen.
- Preguntas sobre el CONTENIDO de una asignatura ("¿qué vamos a hacer mañana en IS?", "¿qué toca en la práctica?", "¿de qué va el tema 3?", "¿qué hay que preparar para la sesión extra?"): llama SIEMPRE a las dos herramientas, ver_agenda (qué sesiones tiene ese día: tipo, hora y aula) y aula_asignatura (qué dice ${moodle} de esa semana o sesión: la planificación del profe si la hay —el calendario con lo que toca cada día—, actividades, instrucciones y avisos). Busca en la planificación la fila de esa fecha. Responde en cuatro o cinco líneas con lo que toca, citando lo que pone ${moodle}. Si no dice nada concreto de ese día, dilo y cuéntale lo más cercano (la semana o el tema en curso). No hables de otras asignaturas ni del resto del día salvo que pregunte.
- Cambiar, mover, marcar hecho o borrar algo que ya existe: usa su id de la lista. Para borrar, llama a borrar directamente (una vez por elemento; los días de una serie se borran juntos): eso ya le pone un botón de confirmación, así que NO le preguntes antes por texto.
${config.notion ? `- ${config.notion.name} vive en Notion. Sus eventos ya salen en la agenda con 🚀. Para cualquier otra cosa de ${config.notion.name} (un proyecto, quién lleva qué, un proceso, un acta, el detalle de un evento) usa notion_buscar y cita la página.\n` : ""}- Si solo charla o pregunta algo general, contesta sin herramientas.

RESPUESTA FINAL
Si al apuntar algo las herramientas devuelven choques (sobre todo exámenes o entregas), avísale claramente, con el día y la hora.
Texto plano para Telegram, sin Markdown (nada de **, # ni tablas); listas con •. Breve. Di lo que has hecho con el día de la semana y la fecha ("jueves 8/11, 17:00–18:00"), los choques que te devuelvan las herramientas y lo que necesites que te confirme.

PAUTAS DE SU SEMANA (las aplica el sistema al colocar tareas; úsalas para razonar)
- Se planifica entre ${p.window.weekday[0]} y ${p.window.weekday[1]} entre semana y entre ${p.window.weekend[0]} y ${p.window.weekend[1]} el fin de semana; comida ${p.lunch[0]}–${p.lunch[1]} entre semana.
- ${p.commute} min de viaje antes de la primera clase presencial y después de la última; ${p.travelBeforeRoutine} min antes de entrenos y ${p.afterRoutine} min después.
- Huecos de menos de ${p.minSlot} min no cuentan; una tarea sin duración son ${p.defaultTaskMin} min.

${subjects ? `ASIGNATURAS: ${subjects}\n` : ""}CATEGORÍAS HABITUALES: ${(me.categories || ["uni", "trabajo", "personal"]).join(", ")} (o un nombre corto en minúsculas).`;
}

async function contextPrompt(env, now, items) {
  return `${todayLine(now)}

LO QUE TIENE GUARDADO (id · tipo · título · cuándo):
${items.map(describe).join("\n") || "(nada)"}

AGENDA DE HOY, MAÑANA Y PASADO (para otros días, ver_agenda):
${await agendaBlock(env, now.date, addDays(now.date, 2), now)}`;
}

// ---------- herramientas ----------

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const S = (description) => ({ type: "string", description });
const N = (description) => ({ type: "integer", description });
const B = (description) => ({ type: "boolean", description });

const TOOLS = [
  fn("ver_agenda", "Agenda real (clases, rutina, exámenes, eventos, bloques de tareas) y huecos libres entre dos fechas (máx. 21 días).",
    { desde: S("YYYY-MM-DD"), hasta: S("YYYY-MM-DD") }, ["desde", "hasta"]),
  fn("aula_global", "Avisos recientes de los profesores y notas publicadas en el Moodle de la uni.", {}),
  fn("aula_asignatura", "Contenido de una asignatura en el Moodle de la uni (planificación de sesiones del profe incluida): temas o semanas, sesiones, prácticas, actividades con fechas, instrucciones del profesor y sus avisos recientes.",
    { asignatura: S("Nombre o alias, p. ej. 'Ingeniería del Software' o 'IS'") }, ["asignatura"]),
  ...(config.notion ? [fn("notion_buscar", `Busca en el Notion de ${config.notion.name} y lee las páginas que encaje: eventos, proyectos, tareas, actas, procesos, contactos.`,
    { consulta: S("Palabras clave, p. ej. 'jornada del sábado', 'formación', 'acta reunión'") }, ["consulta"])] : []),
  fn("crear_evento", "Apunta un evento: de un día o de varios (fecha → fecha_fin), con hora o de día completo sin horario.", {
    titulo: S("Título limpio, p. ej. 'Hackathon HackUPC'"),
    fecha: S("Primer día, YYYY-MM-DD"),
    fecha_fin: S("Último día si dura varios días, YYYY-MM-DD"),
    hora_inicio: S("HH:MM, igual para todos los días; vacío si no se sabe"),
    hora_fin: S("HH:MM"),
    duracion_min: N("Si no hay hora_fin"),
    horario_por_confirmar: B("true si aún no se sabe el horario: se apunta de día completo y se pregunta más adelante"),
    dias: { type: "array", description: "Solo si cada día tiene un horario distinto", items: { type: "object", properties: { fecha: S("YYYY-MM-DD"), hora_inicio: S("HH:MM"), hora_fin: S("HH:MM") }, required: ["fecha"], additionalProperties: false } },
    lugar: S("Lugar si se sabe"),
    categoria: S("Una de sus categorías habituales"),
  }, ["titulo", "fecha"]),
  fn("crear_tarea", "Apunta una tarea; el sistema le busca hueco libre antes de su fecha límite.", {
    titulo: S("Qué hay que hacer. Entregas de la uni: 'Entregar: … · Asignatura'"),
    fecha_limite: S("YYYY-MM-DD si tiene"),
    hora_limite: S("HH:MM si la entrega cierra a una hora"),
    duracion_min: N("Cuánto le llevará, si lo dice"),
    prioridad: { type: "string", enum: ["urgente", "normal", "algun_dia"] },
    categoria: S("Una de sus categorías habituales"),
    sin_hueco: B("true si no hay que reservarle tiempo (se hace durante un evento o es solo una fecha límite)"),
  }, ["titulo"]),
  fn("crear_examen", "Apunta un examen (sustituye a la clase de su asignatura si coincide en hora).", {
    titulo: S("'Parcial de Estructura de Computadores'"), fecha: S("YYYY-MM-DD"), hora_inicio: S("HH:MM"),
    duracion_min: N("Por defecto 90"), lugar: S("Aula si se sabe"),
  }, ["titulo", "fecha"]),
  fn("cancelar_fijo", "Algo de su horario fijo no va a pasar ese día (un partido, un entreno, una clase).", {
    que: S("'partido', 'entreno' o la asignatura"), fecha: S("YYYY-MM-DD"),
  }, ["que", "fecha"]),
  fn("guardar_nota", "Guarda una nota o material sin fecha.", {
    texto: S("Contenido"), tipo: { type: "string", enum: ["nota", "material"] }, categoria: S("Opcional"),
  }, ["texto"]),
  fn("editar", "Cambia algo que ya existe: moverlo de día/hora, renombrarlo, duración o fecha límite.", {
    id: N("id de la lista"), fecha: S("YYYY-MM-DD"), hora: S("HH:MM"), duracion_min: N(""), titulo: S(""),
    que: { type: "string", enum: ["hueco", "fecha_limite"], description: "Solo tareas: mover cuándo la hace o cambiar cuándo vence" },
  }, ["id"]),
  fn("fijar_horario", "Pone horas a un evento de día completo o a cada día de una serie (p. ej. cuando por fin sabe el horario de la hackathon).", {
    id: N("id de cualquier día del evento"),
    dias: { type: "array", items: { type: "object", properties: { fecha: S("YYYY-MM-DD"), hora_inicio: S("HH:MM"), hora_fin: S("HH:MM") }, required: ["fecha", "hora_inicio", "hora_fin"], additionalProperties: false } },
  }, ["id", "dias"]),
  fn("marcar_hecho", "Ya ha hecho o entregado algo de la lista.", { id: N("id") }, ["id"]),
  fn("borrar", "Quiere quitar algo de la lista (se le pide confirmación con un botón; si es de una serie, la serie entera).", { id: N("id") }, ["id"]),
];

// Cada ejecución apunta lo que cambia para el ↩️ Deshacer conjunto y la memoria de la conversación.
function newRun() {
  return { created: [], edited: [], deletions: [], log: [] };
}

async function insertEvent(env, run, { title, date, start, end, allDay, tbc, location, category, series }) {
  const res = await env.DB.prepare(
    `INSERT INTO items (kind, text, category, priority, due_date, start_at, end_at, duration_min, location, series, all_day, tbc)
     VALUES ('evento', ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(title, category, date, start ? `${date}T${start}` : null, end ? `${date}T${end}` : null,
    start && end ? toMin(end) - toMin(start) : null, location, series, allDay ? 1 : 0, tbc ? 1 : 0).run();
  const id = res.meta.last_row_id;
  run.created.push(id);
  return id;
}

function endFor(start, end, dur) {
  if (okTime(end) && toMin(end) > toMin(start)) return end;
  return fromMin(Math.min(toMin(start) + (Number(dur) > 0 ? Number(dur) : 60), 23 * 60 + 59));
}

async function clashes(env, id, date, start, end) {
  const hits = await conflictsFor(env, date, start, end, id);
  return hits.map((h) => `${h.label} (${h.allDay ? "todo el día" : `${h.shown || h.start}–${h.shownEnd || h.end}`})`);
}

// Un día completo choca con todo lo de ese día: exámenes y eventos uno a uno, las clases y entrenos resumidos.
async function dayClashes(env, id, date) {
  const hits = (await conflictsFor(env, date, "00:00", "23:59", id)).filter((h) => h.itemId !== id);
  const key = hits.filter((h) => !/^(📚|🏀|🏃)/.test(h.label)).map((h) => `${h.label} (${h.allDay ? "todo el día" : `${h.shown || h.start}–${h.shownEnd || h.end}`})`);
  const classes = hits.filter((h) => h.label.startsWith("📚")).length;
  const routine = hits.filter((h) => /^(🏀|🏃)/.test(h.label)).map((h) => h.label);
  return [...key, ...(classes ? [`${classes} clase${classes > 1 ? "s" : ""}`] : []), ...routine];
}

const HANDLERS = {
  async ver_agenda(env, a, { now }) {
    let from = okDate(a.desde) || now.date;
    let to = okDate(a.hasta) || addDays(from, 6);
    if (to < from) to = from;
    if (to > addDays(from, 20)) to = addDays(from, 20);
    return { agenda: await agendaBlock(env, from, to, now) };
  },

  async notion_buscar(env, a) {
    return searchNotion(env, a.consulta || "");
  },

  async aula_asignatura(env, a) {
    return courseOutline(env, String(a.asignatura || ""));
  },

  async aula_global(env) {
    const aula = await aulaContext(env);
    return {
      avisos: aula.avisos.slice(0, 10).map((x) => `${x.at} · ${x.course} · ${x.title}: ${x.body.slice(0, 300)}`),
      notas: Object.entries(aula.grades).map(([k, v]) => `${k.replace("|", " · ")}: ${v}`),
    };
  },

  async crear_evento(env, a, { run }) {
    const title = String(a.titulo || "").trim().slice(0, 200);
    const first = okDate(a.fecha);
    if (!title || !first) return { error: "Falta el título o la fecha (YYYY-MM-DD)." };
    let days;
    if (Array.isArray(a.dias) && a.dias.length) {
      days = a.dias.filter((d) => okDate(d.fecha)).map((d) => ({ date: d.fecha, start: okTime(d.hora_inicio), end: okTime(d.hora_fin) }));
    } else {
      const last = okDate(a.fecha_fin) && a.fecha_fin > first ? a.fecha_fin : first;
      days = [];
      for (let d = first; d <= last && days.length < MAX_SERIES_DAYS; d = addDays(d, 1)) {
        days.push({ date: d, start: okTime(a.hora_inicio), end: okTime(a.hora_fin) });
      }
    }
    if (!days.length) return { error: "Ningún día válido." };
    const series = days.length > 1 ? crypto.randomUUID().slice(0, 8) : null;
    const out = [];
    for (const d of days) {
      const timed = !!d.start;
      const end = timed ? endFor(d.start, d.end, a.duracion_min) : null;
      const tbc = !timed && a.horario_por_confirmar !== false;
      const id = await insertEvent(env, run, {
        title, date: d.date, start: d.start, end, allDay: !timed, tbc,
        location: a.lugar || null, category: a.categoria ? String(a.categoria).toLowerCase() : null, series,
      });
      out.push({ id, dia: `${dayLabel(d.date)}${timed ? ` ${d.start}–${end}` : tbc ? " todo el día (horario por confirmar)" : " todo el día"}`,
        choques: timed ? await clashes(env, id, d.date, d.start, end) : await dayClashes(env, id, d.date) });
    }
    run.log.push(`apuntado «${title}» ${out.map((o) => `#${o.id}`).join(" ")}`);
    return { ok: true, serie: series, dias: out };
  },

  async crear_tarea(env, a, { run }) {
    const title = String(a.titulo || "").trim().slice(0, 200);
    if (!title) return { error: "Falta el título." };
    const due = okDate(a.fecha_limite);
    const cls = {
      kind: "tarea", title, priority: ["urgente", "normal", "algun_dia"].includes(a.prioridad) ? a.prioridad : "normal",
      category: a.categoria ? String(a.categoria).toLowerCase() : null, due_date: due,
      duration_min: Number(a.duracion_min) > 0 ? Math.round(Number(a.duracion_min)) : null,
    };
    const { id } = await insertItem(env, title, cls);
    run.created.push(id);
    if (due && okTime(a.hora_limite)) await env.DB.prepare("UPDATE items SET due_at=? WHERE id=?").bind(`${due}T${a.hora_limite}`, id).run();
    let hueco = a.sin_hueco ? "sin hueco: solo fecha límite" : "sin hueco (algún día)";
    if (cls.priority !== "algun_dia" && !a.sin_hueco) {
      const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first();
      hueco = (await placeTask(env, item)).trim();
    }
    run.log.push(`apuntada tarea «${title}» #${id}`);
    return { ok: true, id, vence: due ? `${dayLabel(due)}${okTime(a.hora_limite) ? ` ${a.hora_limite}` : ""}` : null, hueco };
  },

  async crear_examen(env, a, { run }) {
    const date = okDate(a.fecha);
    if (!date) return { error: "Falta la fecha." };
    const { id, agenda } = await insertItem(env, a.titulo, {
      kind: "examen", title: String(a.titulo).slice(0, 200), priority: "normal", category: "uni", due_date: date,
      time: okTime(a.hora_inicio), duration_min: Number(a.duracion_min) > 0 ? Number(a.duracion_min) : null, location: a.lugar || null,
    });
    run.created.push(id);
    run.log.push(`apuntado examen «${a.titulo}» #${id}`);
    return { ok: true, id, detalle: agenda.trim() };
  },

  async cancelar_fijo(env, a, { run }) {
    const date = okDate(a.fecha);
    if (!date || !a.que) return { error: "Falta qué o la fecha." };
    const { id, agenda } = await insertItem(env, a.que, { kind: "cancelacion", title: String(a.que).slice(0, 100), priority: "normal", category: null, due_date: date });
    run.created.push(id);
    run.log.push(`cancelado ${a.que} el ${date} (#${id})`);
    return { ok: true, id, detalle: agenda.trim() };
  },

  async guardar_nota(env, a, { run }) {
    const text = String(a.texto || "").trim().slice(0, 4000);
    if (!text) return { error: "Nota vacía." };
    const { id } = await insertItem(env, text, { kind: a.tipo === "material" ? "material" : "nota", priority: "normal", category: a.categoria ? String(a.categoria).toLowerCase() : null, due_date: null });
    run.created.push(id);
    run.log.push(`guardada nota #${id}`);
    return { ok: true, id };
  },

  async editar(env, a, { run }) {
    const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(Number(a.id)).first();
    if (!item) return { error: `No existe #${a.id}.` };
    const msg = await applyChange(env, item, "editar", { fecha: a.fecha, hora: a.hora, duracion_min: a.duracion_min, titulo: a.titulo, que: a.que });
    if (!msg.startsWith("🤔")) {
      run.edited.push(item.id);
      run.log.push(`editado #${item.id}`);
    }
    return { resultado: msg };
  },

  async fijar_horario(env, a, { run }) {
    const base = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(Number(a.id)).first();
    if (!base) return { error: `No existe #${a.id}.` };
    const siblings = base.series
      ? (await env.DB.prepare("SELECT * FROM items WHERE series=?").bind(base.series).all()).results
      : [base];
    const out = [];
    for (const d of a.dias || []) {
      if (!okDate(d.fecha) || !okTime(d.hora_inicio)) continue;
      const end = endFor(d.hora_inicio, d.hora_fin, 60);
      const row = siblings.find((s) => s.due_date === d.fecha);
      let id;
      if (row) {
        await env.FILES.put(UNDO(row.id), JSON.stringify(Object.fromEntries(COLS.map((k) => [k, row[k]]))), { expirationTtl: 2 * 86400 });
        await env.DB.prepare("UPDATE items SET start_at=?, end_at=?, duration_min=?, all_day=0, tbc=0 WHERE id=?")
          .bind(`${d.fecha}T${d.hora_inicio}`, `${d.fecha}T${end}`, toMin(end) - toMin(d.hora_inicio), row.id).run();
        id = row.id;
        run.edited.push(id);
      } else {
        id = await insertEvent(env, run, { title: base.text, date: d.fecha, start: d.hora_inicio, end, allDay: false, tbc: false, location: base.location, category: base.category, series: base.series });
      }
      out.push({ id, dia: `${dayLabel(d.fecha)} ${d.hora_inicio}–${end}`, choques: await clashes(env, id, d.fecha, d.hora_inicio, end) });
    }
    if (!out.length) return { error: "Ningún día con fecha y hora válidas." };
    const pending = siblings.filter((s) => s.tbc && !out.some((o) => o.id === s.id)).map((s) => dayLabel(s.due_date));
    run.log.push(`horario puesto a «${base.text}» ${out.map((o) => `#${o.id}`).join(" ")}`);
    return { ok: true, dias: out, siguen_sin_horario: pending };
  },

  async marcar_hecho(env, a, { run }) {
    const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(Number(a.id)).first();
    if (!item) return { error: `No existe #${a.id}.` };
    const msg = await applyChange(env, item, "hecho", {});
    run.edited.push(item.id);
    run.log.push(`hecho #${item.id}`);
    return { resultado: msg };
  },

  async borrar(env, a, { run }) {
    const item = await env.DB.prepare("SELECT id, kind, text, series FROM items WHERE id=?").bind(Number(a.id)).first();
    if (!item) return { error: `No existe #${a.id}.` };
    run.deletions.push(item);
    return { ok: true, pendiente: "Le he puesto un botón para confirmar el borrado." };
  },
};

// Telegram va en texto plano: fuera el Markdown que se le escape al modelo.
export function plain(t) {
  return t
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- deshacer en bloque ----------

export async function undoBatch(env, key) {
  const b = await env.FILES.get(`undob:${key}`, { type: "json" });
  if (!b) return "Ya no puedo deshacer eso (han pasado más de 2 días).";
  for (const id of b.created) {
    const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE item_id=?").bind(id).all();
    for (const x of atts.results) await env.FILES.delete(x.r2_key);
    await env.DB.prepare("DELETE FROM attachments WHERE item_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
  }
  for (const id of [...new Set(b.edited)].reverse()) await undoChange(env, id);
  await env.FILES.delete(`undob:${key}`);
  return "↩️ Deshecho: todo vuelve a estar como antes";
}

// ---------- bucle ----------

// `queued`: viene de la cola de espera; si sigue sin cuota devuelve "quota" en vez de volver a encolarlo.
export async function agent(env, chatId, text, { queued = false } = {}) {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  const now = nowMadrid();
  const history = (await env.FILES.get(HISTORY, { type: "json" })) || [];
  const items = await listItems(env, now.date);

  const messages = [
    { role: "system", content: stablePrompt() },
    { role: "system", content: await contextPrompt(env, now, items) },
    ...history,
    { role: "user", content: text.slice(0, MAX_INPUT) },
  ];
  const run = newRun();
  let reply = "";

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const { message } = await chat(env, { messages, tools: TOOLS, effort: "medium" });
      messages.push(message);
      if (!message.tool_calls?.length) {
        reply = message.content.trim();
        break;
      }
      for (const call of message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          const handler = HANDLERS[call.function.name];
          result = handler ? await handler(env, args, { now, run }) : { error: `Herramienta desconocida: ${call.function.name}` };
        } catch (e) {
          console.error("tool", call.function.name, e?.stack || e);
          result = { error: String(e?.message || e).slice(0, 300) };
        }
        console.log(`[agent] ${call.function.name} ${call.function.arguments} → ${JSON.stringify(result).slice(0, 300)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
      }
    }
    // Se ha quedado sin pasos: una última vuelta sin herramientas para que cuente qué ha hecho y qué no.
    if (!reply) {
      messages.push({ role: "system", content: "Se acabaron las herramientas por este mensaje. Responde ya al usuario: qué has hecho, qué no y por qué." });
      reply = (await chat(env, { messages, effort: "low" })).message.content.trim();
    }
  } catch (e) {
    console.error("agent", e?.message || e);
    // Sin modelo y sin haber tocado nada: que lo guarde el camino de siempre (o avise si era una pregunta).
    if (!run.created.length && !run.edited.length && !run.deletions.length) {
      // Sin cuota de IA: a la cola, para hacerlo bien cuando vuelva (no como tarea suelta ni material).
      if (e instanceof QuotaError) {
        if (queued) return "quota";
        await enqueue(env, chatId, { text: text.slice(0, MAX_INPUT) });
        return true;
      }
      if (!/\?\s*$/.test(text)) return false;
      await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No he podido pensar la respuesta ahora mismo. Prueba otra vez en un momento." });
      return true;
    }
    reply = "⚠️ Me he cortado a medias, pero esto ya está hecho.";
  }

  if (!reply) reply = run.log.length ? "Hecho." : "No he sabido qué hacer con eso 🤷";
  reply = plain(reply);
  if (run.log.length) reply += `\n\n${run.log.map((l) => `• ${l}`).join("\n")}`;

  const keyboard = [];
  if (run.created.length || run.edited.length) {
    const key = crypto.randomUUID().slice(0, 12);
    await env.FILES.put(`undob:${key}`, JSON.stringify({ created: run.created, edited: run.edited }), { expirationTtl: 2 * 86400 });
    keyboard.push([{ text: "↩️ Deshacer", callback_data: `ub:${key}` }]);
  }
  for (const d of run.deletions) {
    keyboard.push([
      { text: `🗑 Borrar #${d.id}${d.series ? " (todos los días)" : ""}`, callback_data: `${d.series ? "ds" : "del"}:${d.id}` },
      { text: "Cancelar", callback_data: `keep:${d.id}` },
    ]);
  }
  await tg(env, "sendMessage", {
    chat_id: chatId, text: reply.slice(0, 4000),
    ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

  // Memoria corta: lo que dijo, lo que contesté y lo que hice (con ids) para entender "ponlo a las 18".
  history.push({ role: "user", content: text.slice(0, 3000) }, { role: "assistant", content: reply.slice(0, 1500) });
  await env.FILES.put(HISTORY, JSON.stringify(history.slice(-HISTORY_TURNS)), { expirationTtl: 24 * 3600 });
  return true;
}

/** Para que el bot recuerde lo que preguntó él (p. ej. el horario de la hackathon) y entienda la respuesta. */
export async function rememberAssistant(env, content) {
  const history = (await env.FILES.get(HISTORY, { type: "json" })) || [];
  history.push({ role: "user", content: "(mensaje automático del bot)" }, { role: "assistant", content: content.slice(0, 1500) });
  await env.FILES.put(HISTORY, JSON.stringify(history.slice(-HISTORY_TURNS)), { expirationTtl: 24 * 3600 });
}
