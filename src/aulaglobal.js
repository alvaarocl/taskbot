// Aula Global (Moodle UC3M) con el token de la app móvil (secreto AULAGLOBAL_TOKEN, lo saca
// ~/obsidian/aulaglobal/login.mjs). Solo lectura. Cada 3 h:
// - entregas y cuestionarios pendientes → tareas con fecha límite y hueco en la agenda
// - entregado en Aula Global → la tarea se marca hecha
// - material nuevo en una asignatura → aviso por Telegram
// La descarga de archivos al Mac la hace ~/obsidian/aulaglobal/sync-files.mjs.

import { tg, itemKeyboard } from "./telegram.js";
import { scheduleTask, dayLabel, nowMadrid } from "./brain.js";

const SITE = "https://aulaglobal.uc3m.es";
const YEAR = "26/27"; // asignaturas de este curso: "… 26/27-1C" / "… 26/27-2C"
const FILES_KEY = "ag:files";
const ALERT_KEY = "ag:token-alert";

async function call(env, wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: env.AULAGLOBAL_TOKEN, wsfunction, moodlewsrestformat: "json", ...params });
  const res = await fetch(`${SITE}/webservice/rest/server.php`, { method: "POST", body });
  const data = await res.json();
  if (data?.exception) throw Object.assign(new Error(`${wsfunction}: ${data.message}`), { code: data.errorcode });
  return data;
}

const shortName = (c) => c.fullname.split(/ \d\d\/\d\d-/)[0];
const madridDate = (ts) => new Date(ts * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
const madridTime = (ts) => new Date(ts * 1000).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });

export async function syncAulaGlobal(env) {
  if (!env.AULAGLOBAL_TOKEN || !env.OWNER_CHAT_ID) return;
  let courses;
  try {
    const { userid } = await call(env, "core_webservice_get_site_info");
    courses = (await call(env, "core_enrol_get_users_courses", { userid })).filter((c) => c.fullname.includes(`${YEAR}-`));
  } catch (e) {
    if (["invalidtoken", "accessexception"].includes(e.code)) return tokenAlert(env);
    throw e;
  }
  await env.FILES.delete(ALERT_KEY);
  const names = Object.fromEntries(courses.map((c) => [c.id, shortName(c)]));
  const ids = Object.fromEntries(courses.map((c, i) => [`courseids[${i}]`, String(c.id)]));

  const pending = await pendingWork(env, ids, names);
  await syncTasks(env, pending);
  await notifyNewMaterial(env, courses, names);
}

// Entregas sin entregar y cuestionarios abiertos con fecha, de hace 30 días en adelante.
async function pendingWork(env, ids, names) {
  const from = Math.floor(Date.now() / 1000) - 30 * 86400;
  const out = [];

  const { courses } = await call(env, "mod_assign_get_assignments", ids);
  for (const c of courses) {
    for (const a of c.assignments) {
      const due = a.duedate || a.cutoffdate;
      if (!due || due < from) continue;
      const st = await call(env, "mod_assign_get_submission_status", { assignid: String(a.id) });
      const sub = st.lastattempt?.teamsubmission || st.lastattempt?.submission;
      out.push({
        source: `ag:assign:${a.id}`, course: names[c.id], name: a.name, due,
        done: sub?.status === "submitted", url: `${SITE}/mod/assign/view.php?id=${a.cmid}`,
      });
    }
  }

  const { quizzes } = await call(env, "mod_quiz_get_quizzes_by_courses", ids);
  for (const q of quizzes) {
    if (!q.timeclose || q.timeclose < from) continue;
    const { attempts } = await call(env, "mod_quiz_get_user_attempts", { quizid: String(q.id), status: "finished" });
    out.push({
      source: `ag:quiz:${q.id}`, course: names[q.course], name: q.name, due: q.timeclose,
      done: attempts.length > 0, url: `${SITE}/mod/quiz/view.php?id=${q.coursemodule}`, quiz: true,
    });
  }
  return out;
}

async function syncTasks(env, pending) {
  const today = nowMadrid().date;
  for (const w of pending) {
    const dueDate = madridDate(w.due);
    const item = await env.DB.prepare("SELECT * FROM items WHERE source=?").bind(w.source).first();
    // "Entrega de la práctica 1" → "Entregar: práctica 1 · Estructura de Computadores"
    const what = w.quiz ? w.name : w.name.replace(/^entrega(r)?\s+(de\s+)?(la\s+|los\s+|las\s+|el\s+)?/i, "");
    const label = `${w.quiz ? "Cuestionario" : "Entregar"}: ${what} · ${w.course}`;
    const when = `${dayLabel(dueDate)} ${madridTime(w.due)}`;

    if (!item) {
      if (w.done) continue; // ya entregado antes de conectar Aula Global
      const res = await env.DB.prepare(
        `INSERT INTO items (kind, text, category, priority, due_date, duration_min, source, url)
         VALUES ('tarea', ?, 'uni', ?, ?, ?, ?, ?)`
      ).bind(label, dueDate < today ? "urgente" : "normal", dueDate, w.quiz ? 45 : 120, w.source, w.url).run();
      const id = res.meta.last_row_id;
      let line = "";
      if (dueDate >= today) {
        const { slot } = await scheduleTask(env, { id, due_date: dueDate, duration_min: w.quiz ? 45 : 120 });
        line = slot ? `\n🧠 Te la pongo el ${dayLabel(slot.date)} ${slot.start}–${slot.end}` : "\n🧠 No encuentro hueco antes";
      }
      await tg(env, "sendMessage", {
        chat_id: env.OWNER_CHAT_ID,
        text: `${dueDate < today ? "⚠️ Sin entregar en Aula Global" : "📌 Nueva en Aula Global"}\n${label}\n📅 ${dueDate < today ? "venció" : "vence"} el ${when}${line}\n${w.url}`,
        reply_markup: itemKeyboard(id, "tarea"),
      });
      continue;
    }

    if (w.done && item.status === "pendiente") {
      await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(item.id).run();
      await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: `✅ Entregado en Aula Global: ${w.name} · ${w.course}` });
    } else if (!w.done && item.status === "pendiente" && item.due_date !== dueDate) {
      await env.DB.prepare("UPDATE items SET due_date=? WHERE id=?").bind(dueDate, item.id).run();
      await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: `📅 Cambia la fecha en Aula Global: ${label}\nAhora vence el ${when}` });
    }
  }
}

// Avisa de archivos nuevos o actualizados. La primera vez solo guarda lo que hay.
async function notifyNewMaterial(env, courses, names) {
  const prev = await env.FILES.get(FILES_KEY, { type: "json" });
  const next = {};
  const news = {};
  for (const c of courses) {
    const sections = await call(env, "core_course_get_contents", { courseid: String(c.id) });
    for (const s of sections) {
      for (const m of s.modules || []) {
        for (const f of m.contents || []) {
          if (f.type !== "file") continue;
          const key = `${m.id}:${f.filepath || "/"}${f.filename}`;
          next[key] = f.timemodified;
          if (prev && prev[key] !== f.timemodified) {
            (news[names[c.id]] ||= []).push(`${prev[key] ? "🔄" : "➕"} ${fixName(f.filename)}`);
          }
        }
      }
    }
  }
  await env.FILES.put(FILES_KEY, JSON.stringify(next));
  const blocks = Object.entries(news).map(([course, files]) =>
    `📚 ${course}\n${files.slice(0, 10).join("\n")}${files.length > 10 ? `\n…y ${files.length - 10} más` : ""}`);
  if (blocks.length) {
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_CHAT_ID,
      text: `Material nuevo en Aula Global:\n\n${blocks.join("\n\n")}\n\nSe descarga solo en Documents/26.27/<asignatura>.`.slice(0, 4000),
    });
  }
}

const fixName = (s) => /Ã.|Â./.test(s) ? decodeURIComponent(escape(s)) : s;

// Token caducado o revocado: avisar como mucho una vez al día.
async function tokenAlert(env) {
  if (await env.FILES.get(ALERT_KEY)) return;
  await env.FILES.put(ALERT_KEY, "1", { expirationTtl: 86400 });
  await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID,
    text: "🔑 El acceso a Aula Global ha caducado.\nEn el Mac: cd ~/obsidian/aulaglobal && node login.mjs",
  });
}
