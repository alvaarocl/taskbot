import { tg } from "./telegram.js";

// Se ejecuta cada mañana (cron en wrangler.toml).
// 1) Avisa de tareas vencidas, que vencen hoy o mañana.
// 2) Rescata tareas sin fecha que llevan 2+ semanas pendientes (máx. 5, una vez/semana).
export async function runReminders(env) {
  if (!env.OWNER_CHAT_ID) return;
  const chatId = env.OWNER_CHAT_ID;
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const due = await env.DB.prepare(
    "SELECT * FROM items WHERE status='pendiente' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date"
  ).bind(tomorrow).all();

  if (due.results.length) {
    const overdue = due.results.filter((i) => i.due_date < today);
    const dueToday = due.results.filter((i) => i.due_date === today);
    const dueTomorrow = due.results.filter((i) => i.due_date === tomorrow);
    const fmt = (i) => `• #${i.id} ${i.text}${i.category ? ` [${i.category}]` : ""}`;

    const blocks = [];
    if (overdue.length) blocks.push("⚠️ Atrasadas:\n" + overdue.map(fmt).join("\n"));
    if (dueToday.length) blocks.push("📅 Vencen HOY:\n" + dueToday.map(fmt).join("\n"));
    if (dueTomorrow.length) blocks.push("🔜 Mañana:\n" + dueTomorrow.map(fmt).join("\n"));

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: ("🌅 Buenos días.\n\n" + blocks.join("\n\n")).slice(0, 4000),
    });
  }

  const stale = await env.DB.prepare(
    `SELECT * FROM items
     WHERE status='pendiente' AND kind='tarea' AND due_date IS NULL
       AND created_at < datetime('now', '-14 days')
       AND (reminded_at IS NULL OR reminded_at < datetime('now', '-7 days'))
     ORDER BY created_at LIMIT 5`
  ).all();

  if (stale.results.length) {
    const lines = stale.results.map((i) => `• #${i.id} ${i.text}${i.category ? ` [${i.category}]` : ""}`);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: ("🕸 Llevan más de 2 semanas esperando:\n\n" + lines.join("\n") +
        "\n\n¿Siguen siendo relevantes? Márcalas hechas o bórralas desde el dashboard.").slice(0, 4000),
    });
    const ids = stale.results.map((i) => i.id);
    const ph = ids.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE items SET reminded_at=datetime('now') WHERE id IN (${ph})`).bind(...ids).run();
  }
}
