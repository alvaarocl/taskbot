// Jarvis (opcional): te llama por Telegram a la hora de despertarte y te cuenta el día.
//
//   - Le dices al bot "mañana despiértame a las 8" (o "los días de diario a las 7:30"): el asistente lo guarda aquí.
//   - En el cron de cada media hora, si la hora cae entre 4 y 34 minutos más tarde, escribe el resumen del día y
//     lanza el workflow de GitHub Actions del repo privado de Jarvis (config.jarvis), que hace la llamada
//     (jarvis/call.py). Secreto JARVIS_GH_TOKEN: token de GitHub con permiso de Actions en ese repo.
//   - Al acabar, el workflow avisa en /api/jarvis (Bearer JARVIS_TOKEN): si no lo cogiste, el resumen te llega escrito.

import config from "../config.js";
import { agendaData, nowMadrid, addDays, dayLabel } from "./brain.js";
import { chat } from "./llm.js";
import { tg } from "./telegram.js";
import { cachedEvents } from "./notion.js";

const PLAN = "wake:plan"; // { once: { "YYYY-MM-DD": "HH:MM" }, daily: { days: [1..7], time: "HH:MM" } | null }
const SENT = (date) => `wake:sent:${date}`;
const TEXT = (date) => `wake:text:${date}`;
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const cfg = () => config.jarvis || null;
export const jarvisOn = (env) => !!(cfg() && env.JARVIS_GH_TOKEN);

const loadPlan = async (env) => (await env.FILES.get(PLAN, { type: "json" })) || { once: {}, daily: null };
const savePlan = (env, plan) => env.FILES.put(PLAN, JSON.stringify(plan));
const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay() || 7; // 1 = lunes … 7 = domingo

/** Hora de despertar de un día (la puntual manda sobre la diaria; "off" = ese día no). */
export async function wakeFor(env, date, plan = null) {
  plan ||= await loadPlan(env);
  const once = plan.once?.[date];
  if (once) return once === "off" ? null : once;
  return plan.daily?.days?.includes(weekday(date)) ? plan.daily.time : null;
}

// ---------- lo que hace el asistente ----------

export async function setWake(env, { fecha, hora, dias, quitar }) {
  const plan = await loadPlan(env);
  const today = nowMadrid().date;
  for (const d of Object.keys(plan.once)) if (d < today) delete plan.once[d]; // limpieza
  if (Array.isArray(dias) && dias.length) {
    plan.daily = quitar ? null : { days: [...new Set(dias.map(Number).filter((n) => n >= 1 && n <= 7))].sort(), time: hora };
  } else if (fecha) {
    if (quitar) plan.once[fecha] = plan.daily?.days?.includes(weekday(fecha)) ? "off" : undefined;
    else plan.once[fecha] = hora;
    if (plan.once[fecha] === undefined) delete plan.once[fecha];
  }
  await savePlan(env, plan);
  return describeWake(env, plan);
}

export async function describeWake(env, plan = null) {
  plan ||= await loadPlan(env);
  const today = nowMadrid().date;
  const next = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const t = await wakeFor(env, d, plan);
    if (t) next.push(`${dayLabel(d)} a las ${t}`);
  }
  const daily = plan.daily ? `Todos los ${plan.daily.days.map((n) => DAY_NAMES[n % 7]).join(", ")} a las ${plan.daily.time}.` : "Sin despertador fijo.";
  return { proximos: next, fijo: daily, activo: jarvisOn(env) };
}

// ---------- el resumen que te lee ----------

async function weather() {
  const loc = cfg()?.location;
  if (!loc) return null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Europe%2FMadrid&forecast_days=1`;
    const d = (await (await fetch(u)).json()).daily;
    return `${loc.name}: entre ${Math.round(d.temperature_2m_min[0])} y ${Math.round(d.temperature_2m_max[0])} grados, ${d.precipitation_probability_max[0]}% de probabilidad de lluvia (código ${d.weather_code[0]}).`;
  } catch {
    return null;
  }
}

async function radar(env) {
  const pool = Object.values((await env.FILES.get("social:pool", { type: "json" })) || {});
  return pool.filter((it) => it.first > Date.now() - 36 * 3600e3).sort((a, b) => b.heat - a.heat).slice(0, 3)
    .map((it) => `${it.title} (${it.source})`);
}

/** Datos del día en texto, para el modelo (y como respaldo si no hay modelo). */
export async function dayFacts(env, date) {
  const tomorrow = addDays(date, 1), soon = addDays(date, 3);
  const [agenda, tasks, aula, w, news] = await Promise.all([
    agendaData(env, date),
    env.DB.prepare(
      `SELECT text, due_date, priority, start_at FROM items WHERE status='pendiente' AND kind='tarea'
       AND ((due_date IS NOT NULL AND due_date <= ?) OR substr(start_at,1,10) = ?) ORDER BY due_date`
    ).bind(soon, date).all(),
    env.DB.prepare(
      `SELECT text, due_at FROM items WHERE status='pendiente' AND (source LIKE 'ag:%' OR source LIKE 'crono:%')
       AND due_at BETWEEN ? AND ? ORDER BY due_at`
    ).bind(`${date}T00:00`, `${soon}T23:59`).all(),
    weather(),
    radar(env).catch(() => []),
  ]);
  const notionSoon = (await cachedEvents(env)).filter((e) => e.date > date && e.date <= soon).map((e) => `${e.title} (${dayLabel(e.date)})`);
  const lines = [
    `HOY ${dayLabel(date)}:`,
    ...agenda.blocks.map((b) => `- ${b.allDay ? "todo el día" : `${b.start}-${b.end}`} ${b.label}${b.where ? ` (${b.where})` : ""}`),
    agenda.free.length ? `Huecos libres: ${agenda.free.map((f) => `${f.start}-${f.end}`).join(", ")}` : "Sin huecos libres.",
    "TAREAS:",
    ...tasks.results.map((t) => `- ${t.text}${t.due_date ? ` · vence ${t.due_date < date ? `${t.due_date} (ATRASADA)` : t.due_date === date ? "HOY" : t.due_date === tomorrow ? "mañana" : dayLabel(t.due_date)}` : ""}${t.start_at?.startsWith(date) ? ` · bloque hoy ${t.start_at.slice(11, 16)}` : ""}`),
    "ENTREGAS DE LA UNI (3 días):",
    ...aula.results.map((a) => `- ${a.text} · cierra ${dayLabel(a.due_at.slice(0, 10))} ${a.due_at.slice(11)}`),
    notionSoon.length ? `PRÓXIMOS EVENTOS (${config.notion?.name || "Notion"}): ${notionSoon.join("; ")}` : "",
    w ? `TIEMPO: ${w}` : "",
    news.length ? `LO MÁS COMENTADO EN TECNOLOGÍA: ${news.join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function buildBriefing(env, date, time) {
  const facts = await dayFacts(env, date);
  const name = config.assistant?.name || "";
  try {
    const { message } = await chat(env, {
      effort: "low",
      maxTokens: 1500,
      messages: [
        { role: "system", content: `Eres Jarvis, el asistente personal de ${name || "tu usuario"}, y le despiertas con una llamada. Escribe EXACTAMENTE lo que vas a decir en voz alta, en español de España, cercano y con energía, como un buen asistente: saludo con la hora (${time}), qué tiene hoy en orden (clases con aula, eventos, entrenos), lo que debe hacer o entregar (lo atrasado o que vence hoy primero, con su asignatura), un aviso de lo importante de los próximos días, el tiempo y, al final, una o dos noticias en una frase. Entre 150 y 260 palabras. Es para oírlo: nada de listas, emojis, símbolos, abreviaturas ni URLs; las horas en palabras ("a las nueve y media"); los códigos de aula letra a letra si hace falta ("dos punto tres B cero cinco"). No inventes nada que no esté en los datos.` },
        { role: "user", content: facts },
      ],
    });
    if (message.content?.trim()) return message.content.trim();
  } catch (e) {
    console.error("briefing", e?.message || e);
  }
  // Sin modelo (p. ej. sin cuota): los datos tal cual, leíbles.
  return `Buenos días${name ? `, ${name}` : ""}. Son las ${time}. ${facts.replace(/\n- /g, ". ").replace(/\n/g, ". ").replace(/ · /g, ", ")}`;
}

// ---------- disparo y resultado ----------

async function dispatch(env, wakeAtIso, text) {
  const c = cfg();
  const r = await fetch(`https://api.github.com/repos/${c.repo}/actions/workflows/${c.workflow || "call.yml"}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.JARVIS_GH_TOKEN}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "taskbot",
    },
    body: JSON.stringify({ ref: c.ref || "main", inputs: { wake_at: wakeAtIso, text: text.slice(0, 6000), voice: c.voice || "es-ES-AlvaroNeural", target: String(env.OWNER_CHAT_ID) } }),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// "2026-10-15" + "08:00" (Madrid) → ISO con zona: 2026-10-15T08:00:00+02:00
function madridIso(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(guess);
  const offsetMin = (+local.slice(0, 2) * 60 + +local.slice(3)) - (+time.slice(0, 2) * 60 + +time.slice(3));
  const n = ((offsetMin % 1440) + 1440) % 1440; // la hora local puede caer en el día siguiente o el anterior
  const off = n > 720 ? n - 1440 : n;
  const sign = off >= 0 ? "+" : "-";
  return `${date}T${time}:00${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
}

/** Cron (cada media hora): si toca despertar dentro de 4–34 min, prepara el resumen y lanza la llamada. */
export async function wakeTick(env, at = Date.now()) {
  if (!jarvisOn(env)) return;
  const now = nowMadrid();
  for (const date of [now.date, addDays(now.date, 1)]) {
    const time = await wakeFor(env, date);
    if (!time) continue;
    const iso = madridIso(date, time);
    const left = (Date.parse(iso) - at) / 60000;
    if (left < 4 || left > 34 || await env.FILES.get(SENT(date))) continue;
    await env.FILES.put(SENT(date), "1", { expirationTtl: 2 * 86400 });
    const text = await buildBriefing(env, date, time);
    await env.FILES.put(TEXT(date), text, { expirationTtl: 2 * 86400 });
    try {
      await dispatch(env, iso, text);
      console.log(`[jarvis] llamada programada ${iso}`);
    } catch (e) {
      console.error("jarvis", e?.message || e);
      await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: `⏰ No he podido programar la llamada de las ${time} (${String(e.message).slice(0, 120)}). Aquí tienes el día:\n\n${text}` });
    }
  }
}

/** POST /api/jarvis desde el workflow: { status: "answered" | "no_answer", wake_at }. */
export async function jarvisReport(env, body) {
  const date = String(body?.wake_at || "").slice(0, 10);
  if (body?.status === "answered") return { ok: true };
  const text = (await env.FILES.get(TEXT(date))) || "No he podido recuperar el resumen.";
  await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: `📞 Te he llamado y no lo has cogido. Tu día:\n\n${text}`.slice(0, 4000) });
  return { ok: true };
}
