// Tu Moodle (en la UC3M, Aula Global) con el token de la app móvil de Moodle (secreto AULAGLOBAL_TOKEN;
// cómo sacarlo en DEPLOY.md). Sitio, nombre y curso en config.aulaGlobal. Solo lectura: nunca entrega ni publica nada.
//
// Cada hora (syncAulaGlobal):
//   - entregas y cuestionarios pendientes → tareas con fecha límite y hueco en la agenda
//   - entregado → tarea hecha · cambia la fecha → aviso · recordatorio 24 h y 3 h antes
//   - avisos y foros de los profesores → aviso por Telegram
// Cada 3 h (syncAulaMaterial):
//   - material nuevo o actualizado → aviso
//   - notas nuevas en Calificaciones → aviso
// Lo último de avisos y notas se guarda en KV para que el asistente pueda responder sobre ello.

import config from "../config.js";
import { tg, itemKeyboard } from "./telegram.js";
import { dayLabel, nowMadrid } from "./brain.js";
import { subjectOf } from "./subjects.js";

const SITE = (config.aulaGlobal?.site || "").replace(/\/$/, "");
const NAME = config.aulaGlobal?.name || "Moodle";
const YEAR = config.aulaGlobal?.year || ""; // asignaturas de este curso: "… 26/27-1C" / "… 26/27-2C"; "" = todas
const K = {
  files: "ag:files", forums: "ag:forums", avisos: "ag:avisos", grades: "ag:grades",
  alert: "ag:token-alert", remind: (src, h) => `ag:remind:${src}:${h}`,
};

async function call(env, wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: env.AULAGLOBAL_TOKEN, wsfunction, moodlewsrestformat: "json", ...params });
  const res = await fetch(`${SITE}/webservice/rest/server.php`, { method: "POST", body });
  const data = await res.json();
  if (data?.exception) throw Object.assign(new Error(`${wsfunction}: ${data.message}`), { code: data.errorcode });
  return data;
}

const say = (env, text, extra = {}) => tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 4000), ...extra });
const shortName = (c) => c.fullname.split(/ \d\d\/\d\d-/)[0];
const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const fixName = (s) => (/Ã.|Â./.test(s) ? decodeURIComponent(escape(s)) : s);
const madrid = (ts) => {
  const [date, time] = new Date(ts * 1000).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).split(" ");
  return { date, time: time.slice(0, 5) };
};

const readJSON = (env, key) => env.FILES.get(key, { type: "json" });
async function writeIfChanged(env, key, prev, next) {
  if (JSON.stringify(prev) !== JSON.stringify(next)) await env.FILES.put(key, JSON.stringify(next));
}

// Asignaturas de este curso. Si el token ya no vale, avisa (una vez al día) y devuelve null.
async function connect(env) {
  if (!SITE || !env.AULAGLOBAL_TOKEN || !env.OWNER_CHAT_ID) return null; // módulo apagado
  try {
    const { userid } = await call(env, "core_webservice_get_site_info");
    const courses = (await call(env, "core_enrol_get_users_courses", { userid: String(userid) }))
      .filter((c) => !YEAR || c.fullname.includes(YEAR));
    await env.FILES.delete(K.alert);
    const ids = Object.fromEntries(courses.map((c, i) => [`courseids[${i}]`, String(c.id)]));
    return { userid, courses, ids, names: Object.fromEntries(courses.map((c) => [c.id, shortName(c)])) };
  } catch (e) {
    if (!["invalidtoken", "accessexception"].includes(e.code)) throw e;
    if (!(await env.FILES.get(K.alert))) {
      await env.FILES.put(K.alert, "1", { expirationTtl: 86400 });
      await say(env, `🔑 El acceso a ${NAME} ha caducado. Saca un token nuevo y guárdalo con npx wrangler secret put AULAGLOBAL_TOKEN (ver DEPLOY.md).`);
    }
    return null;
  }
}

export async function syncAulaGlobal(env) {
  const ag = await connect(env);
  if (!ag) return;
  await syncTasks(env, await pendingWork(env, ag));
  await remindDeadlines(env);
  await notifyForums(env, ag);
}

export async function syncAulaMaterial(env) {
  const ag = await connect(env);
  if (!ag) return;
  await notifyNewMaterial(env, ag);
  await notifyGrades(env, ag);
}

// ---------- entregas y cuestionarios ----------

async function pendingWork(env, { ids, names }) {
  const from = Math.floor(Date.now() / 1000) - 30 * 86400;
  const out = [];
  const { courses } = await call(env, "mod_assign_get_assignments", ids);
  for (const c of courses) {
    for (const a of c.assignments) {
      const due = a.duedate || a.cutoffdate;
      if (!due || due < from) continue;
      const st = await call(env, "mod_assign_get_submission_status", { assignid: String(a.id) });
      const sub = st.lastattempt?.teamsubmission || st.lastattempt?.submission;
      out.push({ source: `ag:assign:${a.id}`, course: names[c.id], name: a.name, due,
        done: sub?.status === "submitted", url: `${SITE}/mod/assign/view.php?id=${a.cmid}` });
    }
  }
  const { quizzes } = await call(env, "mod_quiz_get_quizzes_by_courses", ids);
  for (const q of quizzes) {
    if (!q.timeclose || q.timeclose < from) continue;
    const { attempts } = await call(env, "mod_quiz_get_user_attempts", { quizid: String(q.id), status: "finished" });
    out.push({ source: `ag:quiz:${q.id}`, course: names[q.course], name: q.name, due: q.timeclose,
      done: attempts.length > 0, url: `${SITE}/mod/quiz/view.php?id=${q.coursemodule}`, quiz: true });
  }
  return out;
}

function taskLabel(w) {
  // "Entrega de la práctica 1" → "Entregar: práctica 1 · Estructura de Computadores"
  const what = w.quiz ? w.name : w.name.replace(/^entrega(r)?\s+(de\s+)?(la\s+|los\s+|las\s+|el\s+)?/i, "");
  return `${w.quiz ? "Cuestionario" : "Entregar"}: ${what} · ${w.course}`;
}

async function syncTasks(env, pending) {
  const today = nowMadrid().date;
  for (const w of pending) {
    const { date: dueDate, time: dueTime } = madrid(w.due);
    const dueAt = `${dueDate}T${dueTime}`;
    const item = await env.DB.prepare("SELECT * FROM items WHERE source=?").bind(w.source).first();
    const label = taskLabel(w);
    const when = `${dayLabel(dueDate)} ${dueTime}`;
    const minutes = w.quiz ? 45 : 120;

    if (!item) {
      if (w.done) continue; // ya entregado antes de conectar Moodle
      const late = dueDate < today;
      const res = await env.DB.prepare(
        `INSERT INTO items (kind, text, category, priority, due_date, due_at, duration_min, source, url)
         VALUES ('tarea', ?, 'uni', ?, ?, ?, ?, ?, ?)`
      ).bind(label, late ? "urgente" : "normal", dueDate, dueAt, minutes, w.source, w.url).run();
      const id = res.meta.last_row_id;
      await say(env, `${late ? `⚠️ Sin entregar en ${NAME}` : `📌 Nueva en ${NAME}`}\n${label}\n📅 ${late ? "venció" : "vence"} el ${when}\n${w.url}`,
        { reply_markup: itemKeyboard(id, "tarea") });
      continue;
    }

    if (w.done && item.status === "pendiente") {
      await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(item.id).run();
      await say(env, `✅ Entregado en ${NAME}: ${w.name} · ${w.course}`);
    } else if (!w.done && item.status === "pendiente" && item.due_at !== dueAt) {
      await env.DB.prepare("UPDATE items SET due_date=?, due_at=? WHERE id=?").bind(dueDate, dueAt, item.id).run();
      if (item.due_at) await say(env, `📅 Cambia la fecha en ${NAME}: ${label}\nAhora vence el ${when}`);
    }
  }
}

// Recordatorios de lo que vence pronto y sigue sin entregar (cada uno una sola vez).
async function remindDeadlines(env) {
  const now = nowMadrid();
  const nowAt = `${now.date}T${now.time}`;
  const { results } = await env.DB.prepare(
    "SELECT * FROM items WHERE status='pendiente' AND (source LIKE 'ag:%' OR source LIKE 'crono:%') AND due_at IS NOT NULL AND due_at > ?"
  ).bind(nowAt).all();
  for (const it of results) {
    const hours = (Date.parse(it.due_at + ":00Z") - Date.parse(nowAt + ":00Z")) / 3.6e6;
    const h = hours <= 3 ? 3 : hours <= 24 ? 24 : null;
    if (!h || (await env.FILES.get(K.remind(it.source, h)))) continue;
    await env.FILES.put(K.remind(it.source, h), "1", { expirationTtl: 3 * 86400 });
    await say(env, `⏰ ${h === 3 ? "En menos de 3 h" : "En menos de 24 h"} vence: ${it.text}\n📅 ${dayLabel(it.due_date)} ${it.due_at.slice(11)}\n${it.url || ""}`,
      { reply_markup: itemKeyboard(it.id, "tarea") });
  }
}

// ---------- avisos y foros ----------

async function notifyForums(env, { ids, names }) {
  const prev = await readJSON(env, K.forums); // { forumid: numdiscussions }
  const forums = await call(env, "mod_forum_get_forums_by_courses", ids);
  const next = Object.fromEntries(forums.map((f) => [f.id, f.numdiscussions]));
  if (!prev) {
    await seedAvisos(env, forums, names);
  } else {
    const avisos = (await readJSON(env, K.avisos)) || [];
    let changed = false;
    for (const f of forums) {
      const fresh = f.numdiscussions - (prev[f.id] ?? f.numdiscussions);
      if (fresh <= 0) continue;
      const { discussions } = await call(env, "mod_forum_get_forum_discussions",
        { forumid: String(f.id), sortorder: "1", page: "0", perpage: String(Math.min(fresh, 5)) });
      for (const d of discussions.reverse()) {
        const body = strip(d.message);
        const kind = f.type === "news" ? "📢 Aviso" : "💬 Foro";
        avisos.unshift({ course: names[f.course], title: d.name, body: body.slice(0, 600), at: madrid(d.created).date, kind });
        changed = true;
        await say(env, `${kind} · ${names[f.course]}\n${d.name}\n\n${body.slice(0, 700)}${body.length > 700 ? "…" : ""}\n\n${SITE}/mod/forum/discuss.php?d=${d.discussion}`);
      }
    }
    if (changed) await env.FILES.put(K.avisos, JSON.stringify(avisos.slice(0, 20)));
  }
  await writeIfChanged(env, K.forums, prev, next);
}

// Primera vez: guarda los últimos avisos (sin notificar) para que el asistente los conozca.
async function seedAvisos(env, forums, names) {
  const avisos = [];
  for (const f of forums.filter((f) => f.type === "news" && f.numdiscussions > 0)) {
    const { discussions } = await call(env, "mod_forum_get_forum_discussions",
      { forumid: String(f.id), sortorder: "1", page: "0", perpage: "3" });
    for (const d of discussions) {
      avisos.push({ course: names[f.course], title: d.name, body: strip(d.message).slice(0, 600), at: madrid(d.created).date, kind: "📢 Aviso" });
    }
  }
  avisos.sort((a, b) => b.at.localeCompare(a.at));
  await env.FILES.put(K.avisos, JSON.stringify(avisos.slice(0, 20)));
}

// ---------- material y notas ----------

async function notifyNewMaterial(env, { courses, names }) {
  const prev = await readJSON(env, K.files);
  const next = {};
  const news = {};
  for (const c of courses) {
    const sections = await call(env, "core_course_get_contents", { courseid: String(c.id) });
    for (const s of sections) for (const m of s.modules || []) for (const f of m.contents || []) {
      if (f.type !== "file") continue;
      const key = `${m.id}:${f.filepath || "/"}${f.filename}`;
      next[key] = f.timemodified;
      if (prev && prev[key] !== f.timemodified) (news[names[c.id]] ||= []).push(`${prev[key] ? "🔄" : "➕"} ${fixName(f.filename)}`);
    }
  }
  await writeIfChanged(env, K.files, prev, next);
  const blocks = Object.entries(news).map(([course, files]) =>
    `📚 ${course}\n${files.slice(0, 10).join("\n")}${files.length > 10 ? `\n…y ${files.length - 10} más` : ""}`);
  if (blocks.length) await say(env, `Material nuevo en ${NAME}:\n\n${blocks.join("\n\n")}`);
}

async function notifyGrades(env, { userid, courses, names }) {
  const prev = await readJSON(env, K.grades); // { "asignatura|elemento": nota }
  const next = {};
  const news = [];
  for (const c of courses) {
    const { usergrades } = await call(env, "gradereport_user_get_grade_items", { courseid: String(c.id), userid: String(userid) });
    for (const g of usergrades?.[0]?.gradeitems || []) {
      if (g.itemtype === "course") continue;
      const grade = strip(g.gradeformatted);
      if (!grade || grade === "-") continue;
      const key = `${names[c.id]}|${strip(g.itemname)}`;
      next[key] = grade;
      if (prev && prev[key] !== grade) news.push(`📊 ${names[c.id]} · ${strip(g.itemname)}: ${grade}${g.grademax ? ` / ${Number(g.grademax)}` : ""}`);
    }
  }
  await writeIfChanged(env, K.grades, prev, next);
  if (news.length) await say(env, `Notas nuevas en ${NAME}:\n\n${news.join("\n")}`);
}

// Para el asistente: últimos avisos y notas.
export async function aulaContext(env) {
  const [avisos, grades] = await Promise.all([readJSON(env, K.avisos), readJSON(env, K.grades)]);
  return { avisos: avisos || [], grades: grades || {} };
}

// Para el asistente: qué hay en una asignatura (temas/semanas, sesiones, prácticas, actividades con fecha,
// etiquetas con instrucciones del profe y sus últimos avisos). Responde a "¿qué hacemos mañana en IS?".
const MAX_SECTION = 1500;
const MAX_OUTLINE = 14000;
const norm = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Documentos de planificación (calendario de sesiones, cronograma): se leen enteros, porque ahí está
// qué toca cada día. PDF → texto con env.AI.toMarkdown, guardado en KV hasta que el profe lo cambie.
const PLAN = /calendario|cronograma|planificaci|programaci|horario|time ?plan|schedule/i;
const MAX_PLAN = 12000;

async function readPlan(env, mod, file) {
  const key = `ag:doc:${mod.id}:${file.timemodified}`;
  const cached = await env.FILES.get(key);
  if (cached) return cached;
  try {
    const r = await fetch(`${file.fileurl}${file.fileurl.includes("?") ? "&" : "?"}token=${env.AULAGLOBAL_TOKEN}`);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8e6) return null;
    const [res] = await env.AI.toMarkdown([{ name: fixName(file.filename), blob: new Blob([buf], { type: file.mimetype || "application/pdf" }) }]);
    if (!res || res.format === "error" || !res.data) return null;
    const text = res.data.replace(/\n{3,}/g, "\n\n").slice(0, MAX_PLAN);
    await env.FILES.put(key, text, { expirationTtl: 30 * 86400 });
    return text;
  } catch (e) {
    console.error("plan", file.filename, e?.message || e);
    return null;
  }
}

function findCourse(ag, query) {
  const wanted = norm(subjectOf(query) || query);
  const words = wanted.split(" ").filter((w) => w.length > 2);
  const scored = ag.courses.map((c) => {
    const n = norm(shortName(c));
    return { c, score: n.includes(wanted) ? 100 : words.filter((w) => n.includes(w)).length };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].c : null;
}

async function coursePlans(env, sections) {
  const plans = [];
  for (const sec of sections) for (const m of sec.modules || []) {
    if (plans.length >= 2 || m.modname !== "resource" || m.uservisible === false) continue;
    const file = (m.contents || []).find((f) => f.type === "file" && /pdf|word|officedocument|text/.test(f.mimetype || "pdf"));
    if (file && (PLAN.test(m.name) || PLAN.test(file.filename))) {
      const texto = await readPlan(env, m, file);
      if (texto) plans.push({ documento: fixName(m.name), texto });
    }
  }
  return plans;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Filas del calendario del profe para unas fechas (YYYY-MM-DD). El PDF a veces junta varias filas en una
 *  línea, así que se corta por cada fecha dd/mm(/aaaa) que aparece y se quedan los trozos de esas fechas. */
export function planRows(text, dates) {
  const keys = dates.map((d) => { const [y, m, dd] = d.split("-"); return { dd: +dd, m: +m, word: `${+dd} de ${MONTHS[+m - 1]}` }; });
  const out = [];
  // Solo fechas con barra (15/10, 15/10/2026): con punto se confundirían con aulas como "2.3.B05".
  const parts = String(text).split(/(?=\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)/);
  for (const p of parts) {
    const m = p.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m && keys.some((k) => k.dd === +m[1] && k.m === +m[2])) out.push(p.replace(/\s+/g, " ").trim().slice(0, 300));
  }
  for (const line of String(text).split("\n")) {
    if (keys.some((k) => norm(line).includes(norm(k.word)))) out.push(line.trim().slice(0, 300));
  }
  return [...new Set(out)].slice(0, 8);
}

// Lo que toca en clase de varias asignaturas en unas fechas (para el resumen del día y la llamada). En KV 6 h.
export async function classPlans(env, subjects, dates) {
  const key = `ag:plan:${dates.join(",")}:${norm(subjects.join("|")).slice(0, 120)}`;
  const cached = await readJSON(env, key);
  if (cached) return cached;
  const ag = await connect(env);
  if (!ag) return {};
  const out = {};
  for (const sub of subjects) {
    const course = findCourse(ag, sub);
    if (!course) continue;
    try {
      const sections = await call(env, "core_course_get_contents", { courseid: String(course.id) });
      const rows = (await coursePlans(env, sections)).flatMap((p) => planRows(p.texto, dates));
      if (rows.length) out[sub] = rows;
    } catch (e) {
      console.error("classPlans", sub, e?.message || e);
    }
  }
  await env.FILES.put(key, JSON.stringify(out), { expirationTtl: 6 * 3600 });
  return out;
}

// `fecha` (YYYY-MM-DD): solo lo de ese día (y los 3 siguientes) del calendario del profe: respuesta corta y rápida.
export async function courseOutline(env, query, fecha = null) {
  const ag = await connect(env);
  if (!ag) return { error: `${NAME} no está conectado (falta el token o ha caducado).` };
  const course = findCourse(ag, query);
  if (!course) return { error: `No encuentro esa asignatura. Las de este curso son: ${ag.courses.map(shortName).join(", ")}.` };
  const sections = await call(env, "core_course_get_contents", { courseid: String(course.id) });
  const plans = await coursePlans(env, sections);
  const avisos = ((await readJSON(env, K.avisos)) || [])
    .filter((a) => a.course === shortName(course)).slice(0, 3)
    .map((a) => `${a.at} · ${a.title}: ${a.body.slice(0, 300)}`);

  if (fecha) {
    const dates = [0, 1, 2, 3].map((n) => new Date(Date.parse(fecha + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10));
    const rows = plans.flatMap((p) => planRows(p.texto, dates));
    if (rows.length) return { asignatura: shortName(course), fecha, calendario_del_profe: rows, avisos_recientes: avisos };
  }

  const when = (ts) => { const m = madrid(ts); return `${dayLabel(m.date)} ${m.time}`; };
  const parts = [];
  for (const sec of sections) {
    if (sec.uservisible === false) continue;
    const lines = [];
    const summary = strip(sec.summary);
    if (summary) lines.push(summary.slice(0, 500));
    for (const m of sec.modules || []) {
      if (m.uservisible === false) continue;
      const desc = strip(m.description);
      if (m.modname === "label") {
        if (desc) lines.push(`🏷 ${desc.slice(0, 400)}`);
        continue;
      }
      const dates = (m.dates || []).map((d) => `${strip(d.label).replace(/:$/, "")} ${when(d.timestamp)}`).join("; ");
      const files = (m.contents || []).filter((f) => f.type === "file").length;
      lines.push(`• ${fixName(m.name)} [${m.modname}]${dates ? ` · ${dates}` : ""}${files > 1 ? ` · ${files} archivos` : ""}${desc ? ` — ${desc.slice(0, 200)}` : ""}`);
    }
    if (lines.length) parts.push(`## ${strip(sec.name) || "General"}\n${lines.join("\n").slice(0, MAX_SECTION)}`);
  }
  let contenido = parts.join("\n\n");
  const limit = fecha ? 3000 : MAX_OUTLINE;
  if (contenido.length > limit) contenido = `${contenido.slice(0, limit)}\n…(recortado)`;
  return {
    asignatura: shortName(course), hoy: nowMadrid().date,
    planificacion: fecha ? [] : plans, // sin fecha: el calendario entero del profe
    contenido: contenido || "(la asignatura no tiene contenido visible)", avisos_recientes: avisos,
  };
}
