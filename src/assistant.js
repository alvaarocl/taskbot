// El asistente: decide si un mensaje es una pregunta, algo que apuntar o un cambio sobre lo que
// ya hay, y lo resuelve. Lo que haya que apuntar sigue el camino de siempre (classify → insertItem).
//
// Pregunta → responde con la agenda real (clases, rutina, exámenes, eventos, bloques), tareas,
//            avisos y notas de Aula Global.
// Cambio   → mover/renombrar/cambiar fecha límite (con ↩️ Deshacer), marcar hecho, borrar (con
//            confirmación). Mover un examen deja la clase de ese día como estaba.

import { tg } from "./telegram.js";
import {
  loadBusy, freeSlots, findSlot, nowMadrid, addDays, dayLabel, toMin, fromMin, conflictsFor,
} from "./brain.js";
import { aulaContext } from "./aulaglobal.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const HISTORY = "chat:history";
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Devuelve true si el mensaje ya está resuelto; false si hay que apuntarlo.
export async function assistant(env, chatId, text) {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  const now = nowMadrid();
  const history = (await env.FILES.get(HISTORY, { type: "json" })) || [];
  const items = await listItems(env, now.date);

  let route;
  try {
    route = await ask(env, routerPrompt(now, items), history, text, 300);
  } catch (e) {
    console.error("router error:", e?.message || e);
    // Si la IA falla, una pregunta no debe acabar guardada como tarea.
    if (!/\?\s*$/.test(text)) return false;
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No he podido pensar la respuesta ahora mismo. Prueba otra vez en un momento." });
    return true;
  }

  const intent = route?.intent;
  if (intent === "apuntar" || !intent) return false;

  let reply;
  if (intent === "pregunta") {
    reply = await answer(env, now, items, history, text, route);
    await tg(env, "sendMessage", { chat_id: chatId, text: reply.slice(0, 4000) });
  } else {
    const item = items.find((i) => i.id === Number(route.id));
    if (!item) {
      reply = "🤔 No sé a qué te refieres. Dime el nombre o la fecha de lo que quieres cambiar.";
      await tg(env, "sendMessage", { chat_id: chatId, text: reply });
    } else if (intent === "borrar") {
      reply = `¿Borro esto?\n${describe(item)}`;
      await tg(env, "sendMessage", {
        chat_id: chatId, text: reply,
        reply_markup: { inline_keyboard: [[{ text: "🗑 Sí, borrar", callback_data: `del:${item.id}` }, { text: "Cancelar", callback_data: `keep:${item.id}` }]] },
      });
    } else {
      reply = await applyChange(env, item, intent, route.cambios || {});
      await tg(env, "sendMessage", {
        chat_id: chatId, text: reply,
        reply_markup: { inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `undo:${item.id}` }]] },
      });
    }
  }

  history.push({ role: "user", content: text }, { role: "assistant", content: reply.slice(0, 600) });
  await env.FILES.put(HISTORY, JSON.stringify(history.slice(-8)), { expirationTtl: 3 * 3600 });
  return true;
}

// ---------- contexto ----------

// Lo que se puede consultar o cambiar: tareas, eventos y exámenes pendientes, y cancelaciones.
async function listItems(env, today) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, text, priority, due_date, due_at, start_at, end_at, location, url FROM items
     WHERE (kind IN ('tarea','evento') AND status='pendiente')
        OR kind='examen'
        OR (kind='cancelacion' AND due_date >= ?)
     ORDER BY COALESCE(start_at, due_date, '9999') LIMIT 120`
  ).bind(addDays(today, -7)).all();
  return results;
}

function describe(i) {
  const when = i.start_at
    ? `${dayLabel(i.start_at.slice(0, 10))} ${i.start_at.slice(11, 16)}–${i.end_at.slice(11, 16)}`
    : i.due_date ? dayLabel(i.due_date) : "sin fecha";
  const due = i.kind === "tarea" && i.due_date ? ` · vence ${dayLabel(i.due_date)}${i.due_at ? ` ${i.due_at.slice(11)}` : ""}` : "";
  const kind = { tarea: "tarea", evento: "evento", examen: "examen", cancelacion: "cancelación" }[i.kind];
  return `#${i.id} · ${kind} · ${i.text} · ${i.kind === "tarea" ? (i.start_at ? `hueco ${when}` : "sin hueco") : when}${due}`;
}

// Los modelos fallan calculando "mañana" o "el jueves": se les da el calendario ya resuelto.
function todayLine(now) {
  const dow = (d) => DAYS[new Date(d + "T12:00:00Z").getUTCDay()];
  const next = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(now.date, i + 1);
    return `${dow(d)} ${d}${i === 0 ? " (mañana)" : i === 1 ? " (pasado mañana)" : ""}`;
  });
  return `Hoy es ${dow(now.date)} ${now.date}, son las ${now.time} (hora de Madrid). ` +
    `Próximos días: ${next.join(", ")}. "El jueves" = el próximo jueves de esa lista. ` +
    `La semana 1 del curso empezó el lunes 2026-09-07.`;
}

async function agendaBlock(env, from, to, now) {
  const busy = await loadBusy(env, from, to);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const lines = busy.filter((b) => b.date === d && !b.hidden)
      .map((b) => `  ${b.shown || b.start}–${b.shownEnd || b.end} ${b.label}${b.where ? ` (${b.where})` : ""}`);
    const free = freeSlots(busy, d, d === now.date ? toMin(now.time) : 0).map(([s, e]) => `${fromMin(s)}–${fromMin(e)}`);
    out.push(`${DAYS[new Date(d + "T12:00:00Z").getUTCDay()]} ${d}:\n${lines.join("\n") || "  (nada)"}\n  libre: ${free.join(", ") || "nada"}`);
  }
  return out.join("\n");
}

// ---------- IA ----------

async function ask(env, system, history, text, maxTokens) {
  const res = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: text.slice(0, 1500) }],
    max_tokens: maxTokens,
  });
  const out = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  if (out && typeof out === "object") return out;
  const m = String(out || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("router sin JSON");
  return JSON.parse(m[0]);
}

function routerPrompt(now, items) {
  return `Eres el router del asistente personal de Álvaro (estudiante de Ingeniería Informática en la UC3M que entrena baloncesto). ${todayLine(now)}

Lo que tiene guardado (id · tipo · título · cuándo):
${items.map(describe).join("\n") || "(nada)"}

Decide qué quiere con su último mensaje y responde SOLO con un JSON:
{"intent": "...", "id": número o null, "desde": "YYYY-MM-DD" o null, "hasta": "YYYY-MM-DD" o null, "cambios": {...} o null}

intent:
- "pregunta": pregunta algo sobre su agenda, horario, clases, exámenes, entregas, tareas, huecos libres, avisos o notas de Aula Global ("¿qué tengo mañana?", "¿cuándo es el parcial de SO?", "¿tengo hueco el jueves por la tarde?", "¿qué ha dicho el profe de IS?"). Pon en "desde"/"hasta" los días que hacen falta para responder (máximo 21 días; si no se sabe, null).
- "apuntar": quiere guardar algo NUEVO: tarea, recordatorio, reunión, cita, examen nuevo, nota, o decir que algo de su horario fijo NO va a pasar ("este sábado no hay partido", "no hay clase de IA el martes"). Ante la duda entre apuntar y otra cosa, "apuntar".
- "editar": cambiar algo que YA está en la lista: moverlo de día/hora, renombrarlo, cambiar la duración o la fecha límite ("el control de Cálculo del 5 lo pasan al 13 a las 10:45", "mueve la reunión con Marco a las 18", "la práctica de SO pónmela el jueves"). "id" = el elemento de la lista. "cambios": {"fecha": "YYYY-MM-DD" o null, "hora": "HH:MM" o null, "duracion_min": número o null, "titulo": texto o null, "que": "hueco" (mover cuándo la hace) o "fecha_limite" (cambia cuándo vence) — solo para tareas}.
- "borrar": quitar algo de la lista ("ese examen ya no existe", "borra la reunión del jueves", "quita la cancelación del partido"). "id" = el elemento.
- "hecho": dice que ya ha hecho o entregado algo de la lista. "id" = el elemento.

Usa los mensajes anteriores para entender referencias como "ese", "el de antes" o "y el jueves?".`;
}

async function answer(env, now, items, history, text, route) {
  let from = /^\d{4}-\d{2}-\d{2}$/.test(route.desde || "") ? route.desde : now.date;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(route.hasta || "") ? route.hasta : addDays(from, 6);
  if (to < from) to = from;
  if (to > addDays(from, 20)) to = addDays(from, 20);

  const [agenda, aula] = await Promise.all([agendaBlock(env, from, to, now), aulaContext(env)]);
  const exams = items.filter((i) => i.kind === "examen" && (i.due_date || "") >= now.date).map(describe);
  const tasks = items.filter((i) => i.kind === "tarea").map(describe);
  const avisos = aula.avisos.slice(0, 10).map((a) => `- ${a.at} · ${a.course} · ${a.title}: ${a.body.slice(0, 300)}`);
  const grades = Object.entries(aula.grades).map(([k, v]) => `- ${k.replace("|", " · ")}: ${v}`);

  const system = `Eres el asistente personal de Álvaro en Telegram. ${todayLine(now)}
Responde en español, cercano y breve (Telegram, sin Markdown: usa saltos de línea y • para listas). Usa SOLO estos datos; si algo no está, dilo claramente y no te lo inventes. Cuando hables de días di el día de la semana y la fecha (p. ej. "jueves 8/10").
Si pregunta qué tiene un día, enumera TODO lo de la agenda de ese día en orden (clases, exámenes, entrenos, eventos, bloques de tareas) y al final sus huecos libres. Las horas (también las de los huecos libres) cópialas EXACTAMENTE como aparecen en los datos, sin redondear ni calcular otras: los huecos ya descuentan comida y viajes.
🧠 son bloques que el bot le ha reservado para tareas; 🏀 entrenos/partidos; 📚 clases; 📝 exámenes; 📅 eventos. Los entrenos llevan 30 min de viaje antes.

AGENDA ${from} → ${to}:
${agenda}

EXÁMENES PRÓXIMOS:
${exams.join("\n") || "(ninguno)"}

TAREAS PENDIENTES:
${tasks.join("\n") || "(ninguna)"}

AVISOS RECIENTES DE AULA GLOBAL:
${avisos.join("\n") || "(ninguno)"}

NOTAS PUBLICADAS EN AULA GLOBAL:
${grades.join("\n") || "(ninguna)"}`;

  const res = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: text.slice(0, 1500) }],
    max_tokens: 700,
  });
  const out = res?.response ?? res?.choices?.[0]?.message?.content;
  return typeof out === "string" && out.trim() ? out.trim() : "No he sabido responder a eso 🤷";
}

// ---------- cambios ----------

const UNDO = (id) => `undo:${id}`;
const COLS = ["text", "due_date", "due_at", "start_at", "end_at", "duration_min", "status"];

async function applyChange(env, item, intent, c) {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(item.id).first();
  await env.FILES.put(UNDO(item.id), JSON.stringify(Object.fromEntries(COLS.map((k) => [k, row[k]]))), { expirationTtl: 2 * 86400 });

  if (intent === "hecho") {
    await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(item.id).run();
    return `✅ Hecho: ${row.text}`;
  }

  const set = {};
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "") ? c.fecha : null;
  const hora = /^\d{2}:\d{2}$/.test(c.hora || "") ? c.hora : null;
  const dur = Number(c.duracion_min) > 0 ? Math.round(Number(c.duracion_min)) : null;
  if (typeof c.titulo === "string" && c.titulo.trim()) set.text = c.titulo.trim().slice(0, 200);

  let extra = "";
  if (row.kind === "tarea" && c.que === "fecha_limite" && fecha) {
    set.due_date = fecha;
    if (row.due_at) set.due_at = `${fecha}T${hora || row.due_at.slice(11)}`;
  } else if (row.kind === "tarea" && (fecha || hora || dur)) {
    // Mover el hueco donde la hace: a esa hora, o al primer hueco libre de ese día.
    const minutes = dur || row.duration_min || (row.start_at ? toMin(row.end_at.slice(11)) - toMin(row.start_at.slice(11)) : 60);
    const day = fecha || row.start_at?.slice(0, 10) || nowMadrid().date;
    if (hora) {
      set.start_at = `${day}T${hora}`;
      set.end_at = `${day}T${fromMin(Math.min(toMin(hora) + minutes, 23 * 60 + 59))}`;
    } else {
      const now = nowMadrid();
      const after = day === now.date ? now : { date: day, time: "00:00" };
      const slot = findSlot(await loadBusy(env, day, day, row.id), minutes, after, day);
      if (slot) {
        set.start_at = `${slot.date}T${slot.start}`;
        set.end_at = `${slot.date}T${slot.end}`;
      } else {
        extra = `\n⚠️ Ese día no tienes ningún hueco libre de ${minutes} min`;
      }
    }
    if (dur) set.duration_min = dur;
  } else if (fecha || hora || dur) {
    // Evento o examen: misma duración salvo que se diga otra.
    const start = row.start_at || `${row.due_date}T${hora || "09:00"}`;
    const minutes = dur || (row.end_at ? toMin(row.end_at.slice(11)) - toMin(start.slice(11)) : 60);
    const day = fecha || start.slice(0, 10);
    const t = hora || start.slice(11, 16);
    if (row.start_at || hora) {
      set.start_at = `${day}T${t}`;
      set.end_at = `${day}T${fromMin(Math.min(toMin(t) + minutes, 23 * 60 + 59))}`;
    }
    set.due_date = day;
    if (dur) set.duration_min = dur;
  }

  const keys = Object.keys(set);
  if (!keys.length) return `🤔 No he entendido qué cambiar de: ${row.text}`;
  await env.DB.prepare(`UPDATE items SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...keys.map((k) => set[k]), item.id).run();

  const after = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(item.id).first();
  let clash = "";
  if (after.start_at && after.kind !== "tarea") {
    const hits = (await conflictsFor(env, after.start_at.slice(0, 10), after.start_at.slice(11, 16), after.end_at.slice(11, 16), after.id))
      .filter((h) => !(after.kind === "examen" && h.label.startsWith("📚")));
    if (hits.length) clash = `\n⚠️ Choca con: ${hits.map((h) => `${h.label} (${h.shown || h.start}–${h.shownEnd || h.end})`).join(", ")}`;
  }
  const moved = row.kind === "examen" && row.start_at !== after.start_at && row.start_at
    ? `\nEl ${dayLabel(row.start_at.slice(0, 10))} vuelve a salir la clase normal.` : "";
  return `✏️ Cambiado:\n${describe(after)}${moved}${clash}${extra}`;
}

// Botón ↩️ Deshacer.
export async function undoChange(env, id) {
  const prev = await env.FILES.get(UNDO(id), { type: "json" });
  if (!prev) return "Ya no puedo deshacer eso (han pasado más de 2 días).";
  await env.DB.prepare(`UPDATE items SET ${COLS.map((k) => `${k}=?`).join(", ")} WHERE id=?`)
    .bind(...COLS.map((k) => prev[k] ?? null), id).run();
  await env.FILES.delete(UNDO(id));
  return "↩️ Deshecho: vuelve a estar como antes";
}
