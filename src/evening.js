// Cierre del día (opcional, config.evening). Por la noche, lo que ha quedado pendiente: tareas que vencían hasta
// hoy y bloques de hoy sin hacer. Con un botón cada una pasa a mañana o se marca hecha; también todo de golpe.
// Si no queda nada, no escribe. Lo que no toques sigue igual (y puedes contestar "pasa X al lunes" al asistente).
//
// "A mañana": si tenía bloque, se le busca hueco mañana; si solo tenía fecha, la fecha pasa a mañana.
// Las entregas de la uni (Aula Global, cronogramas) no se mueven: su fecha no es tuya. Solo ✅.

import config from "../config.js";
import { shortTitle } from "./presentation.js";
import { tg } from "./telegram.js";
import { nowMadrid, addDays, dayLabel, scheduleTask } from "./brain.js";
import { rememberAssistant } from "./agent.js";

const MAX = 8;
const STATE = (date) => `evening:${date}`; // { ids, log }: para rehacer el mensaje al pulsar
const fixedDeadline = (it) => /^(ag|crono|notion):/.test(it.source || "");

async function pendingToday(env, date) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM items WHERE status='pendiente' AND kind='tarea' AND priority != 'algun_dia'
     AND ((due_date IS NOT NULL AND due_date <= ?) OR substr(start_at,1,10) = ?)
     ORDER BY due_date IS NULL, due_date, start_at LIMIT ?`
  ).bind(date, date, MAX).all();
  return results;
}

function why(it, date) {
  if (it.start_at?.startsWith(date) && !(it.due_date && it.due_date < date)) return `bloque de hoy a las ${it.start_at.slice(11, 16)}`;
  if (it.due_date < date) return `vencía el ${dayLabel(it.due_date)}`;
  if (it.due_at) return `cierra hoy a las ${it.due_at.slice(11, 16)}`;
  return "vence hoy";
}

function render(items, date, log = []) {
  const lines = items.map((it) => `• ${it.text} — ${why(it, date)}`);
  const text = [
    "🌙 Cierre del día",
    lines.length ? `Ha quedado pendiente:\n${lines.join("\n")}` : "Todo resuelto 👌",
    log.length ? log.join("\n") : "",
  ].filter(Boolean).join("\n\n");
  const rows = items.map((it) => [
    { text: `✅ ${shortTitle(it.text, 26)}`, callback_data: `cd:${it.id}` },
    ...(fixedDeadline(it) ? [] : [{ text: `➡️ a mañana`, callback_data: `cm:${it.id}` }]),
  ]);
  if (items.some((it) => !fixedDeadline(it))) rows.push([{ text: "➡️ Todo a mañana", callback_data: `ca:${date}` }, { text: "👌 Lo dejo así", callback_data: `ck:${date}` }]);
  else if (items.length) rows.push([{ text: "👌 Lo dejo así", callback_data: `ck:${date}` }]);
  return { text: text.slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

/** Cron de la noche. */
export async function eveningClose(env) {
  if (!config.evening || !env.OWNER_CHAT_ID) return;
  const { date } = nowMadrid();
  const items = await pendingToday(env, date);
  if (!items.length) return;
  await env.FILES.put(STATE(date), JSON.stringify({ ids: items.map((i) => i.id), log: [] }), { expirationTtl: 3 * 86400 });
  await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, ...render(items, date) });
  await rememberAssistant(env, `Cierre del día: le he preguntado qué hacer con lo pendiente: ${items.map((i) => `#${i.id} ${i.text}`).join("; ")}.`);
}

async function toTomorrow(env, it, today) {
  const tomorrow = addDays(today, 1);
  if (!it.due_date || it.due_date <= today) {
    await env.DB.prepare("UPDATE items SET due_date=?, due_at=NULL WHERE id=?").bind(tomorrow, it.id).run();
  }
  if (!it.start_at) return `➡️ ${it.text}: para mañana`;
  const fresh = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(it.id).first();
  const { slot, late } = await scheduleTask(env, fresh, { date: tomorrow, time: "00:00" });
  if (!slot) {
    await env.DB.prepare("UPDATE items SET start_at=NULL, end_at=NULL WHERE id=?").bind(it.id).run();
    return `➡️ ${it.text}: para mañana (sin hueco libre)`;
  }
  return `➡️ ${it.text}: ${dayLabel(slot.date)} ${slot.start}–${slot.end}${late ? " (no cabía antes)" : ""}`;
}

/** Botones: cd (hecha), cm (a mañana), ca (todo a mañana), ck (lo dejo así). */
export async function eveningCallback(env, cb, action, arg) {
  const chat_id = cb.message.chat.id, message_id = cb.message.message_id;
  const date = action === "ca" || action === "ck" ? arg : null;
  // El estado es del día del mensaje; si se pulsa pasada la medianoche, se busca el de ayer.
  const today = nowMadrid().date;
  const day = date || ((await env.FILES.get(STATE(today))) ? today : addDays(today, -1));
  const state = (await env.FILES.get(STATE(day), { type: "json" })) || { ids: [], log: [] };
  const load = async (id) => env.DB.prepare("SELECT * FROM items WHERE id=? AND status='pendiente'").bind(id).first();

  let notice = "";
  if (action === "ck") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Vale, lo dejo así" });
    await tg(env, "editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (action === "cd") {
    const id = Number(arg);
    const it = await load(id);
    if (it) {
      await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(id).run();
      state.log.push(`✅ ${it.text}`);
    }
    state.ids = state.ids.filter((x) => x !== id);
    notice = "✅ Hecha";
  } else if (action === "cm" || action === "ca") {
    const ids = action === "cm" ? [Number(arg)] : state.ids;
    for (const id of ids) {
      const it = await load(id);
      if (!it || fixedDeadline(it)) continue;
      state.log.push(await toTomorrow(env, it, day));
      state.ids = state.ids.filter((x) => x !== id);
    }
    notice = "➡️ A mañana";
  }
  await env.FILES.put(STATE(day), JSON.stringify(state), { expirationTtl: 3 * 86400 });
  const items = (await Promise.all(state.ids.map(load))).filter(Boolean);
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
  await tg(env, "editMessageText", { chat_id, message_id, ...render(items, day, state.log) });
}
