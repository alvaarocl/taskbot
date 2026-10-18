import { tg } from "./telegram.js";
import { agendaText, nowMadrid, addDays, dayLabel } from "./brain.js";
import { rememberAssistant } from "./agent.js";

const ASK_DAYS = 3; // días antes de un evento sin horario en los que se pregunta (cada 2 días hasta que se sepa)

// Se ejecuta cada mañana (cron en wrangler.toml).
// 1) Avisa de tareas vencidas, que vencen hoy o mañana.
// 2) Rescata tareas sin fecha que llevan 2+ semanas pendientes (máx. 5, una vez/semana).
export async function runReminders(env) {
  if (!env.OWNER_CHAT_ID) return;
  const chatId = env.OWNER_CHAT_ID;
  const today = nowMadrid().date;
  const tomorrow = new Date(Date.parse(today + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);

  const due = await env.DB.prepare(
    "SELECT * FROM items WHERE status='pendiente' AND kind='tarea' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date"
  ).bind(tomorrow).all();

  let agenda = "";
  try {
    agenda = await agendaText(env, today);
  } catch (e) {
    console.error("agenda error:", e?.message || e);
  }

  if (due.results.length || agenda) {
    const overdue = due.results.filter((i) => i.due_date < today);
    const dueToday = due.results.filter((i) => i.due_date === today);
    const dueTomorrow = due.results.filter((i) => i.due_date === tomorrow);
    const fmt = (i) => `• ${i.text}${i.category ? ` [${i.category}]` : ""}`;

    const blocks = agenda ? [agenda] : [];
    if (overdue.length) blocks.push("⚠️ Atrasadas:\n" + overdue.map(fmt).join("\n"));
    if (dueToday.length) blocks.push("📅 Vencen HOY:\n" + dueToday.map(fmt).join("\n"));
    if (dueTomorrow.length) blocks.push("🔜 Mañana:\n" + dueTomorrow.map(fmt).join("\n"));

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: ("🌅 Buenos días.\n\n" + blocks.join("\n\n")).slice(0, 4000),
    });
  }

  await askPendingTimes(env, chatId, today);

  const stale = await env.DB.prepare(
    `SELECT * FROM items
     WHERE status='pendiente' AND kind='tarea' AND due_date IS NULL
       AND created_at < datetime('now', '-14 days')
       AND (reminded_at IS NULL OR reminded_at < datetime('now', '-7 days'))
     ORDER BY created_at LIMIT 5`
  ).all();

  if (stale.results.length) {
    const lines = stale.results.map((i) => `• ${i.text}${i.category ? ` [${i.category}]` : ""}`);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: ("🕸 Llevan más de 2 semanas esperando:\n\n" + lines.join("\n") +
        "\n\n¿Siguen siendo relevantes? Márcalas hechas o bórralas desde el panel.").slice(0, 4000),
    });
    const ids = stale.results.map((i) => i.id);
    const ph = ids.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE items SET reminded_at=datetime('now') WHERE id IN (${ph})`).bind(...ids).run();
  }
}

// Eventos de día completo con "horario por confirmar" que empiezan en los próximos días: pregunta el horario.
// La pregunta se guarda en la memoria del asistente, así que la respuesta ("de 9 a 20, el último día hasta las 14")
// la entiende y la aplica con fijar_horario.
async function askPendingTimes(env, chatId, today) {
  const { results } = await env.DB.prepare(
    `SELECT id, text, series, MIN(due_date) AS first, MAX(due_date) AS last FROM items
     WHERE status='pendiente' AND kind='evento' AND tbc=1 AND due_date >= ?
     GROUP BY COALESCE(series, CAST(id AS TEXT))
     HAVING MIN(due_date) <= ?`
  ).bind(today, addDays(today, ASK_DAYS)).all();
  for (const ev of results) {
    const key = `asktbc:${ev.series || ev.id}`;
    if (await env.FILES.get(key)) continue;
    const when = ev.first === ev.last ? dayLabel(ev.first) : `${dayLabel(ev.first)} – ${dayLabel(ev.last)}`;
    const text = `🕐 «${ev.text}» (${when}) sigue sin horario. ¿Ya lo sabes? Dímelo (p. ej. "de 9 a 20, el último día hasta las 14") y lo pongo en el calendario. `;
    await tg(env, "sendMessage", { chat_id: chatId, text });
    await rememberAssistant(env, text);
    await env.FILES.put(key, "1", { expirationTtl: 2 * 86400 });
  }
}
