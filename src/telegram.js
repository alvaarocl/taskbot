import { classify, transcribe, classifyAudioTranscript } from "./classify.js";
import { loadSessions } from "./sync.js";
import { replacedBy } from "./exams.js";
import { cancellationEffect } from "./overrides.js";
import { assistant, undoChange } from "./assistant.js";
import { socialCommand, socialCallback } from "./social.js";
import {
  agendaText, weekFreeText, scheduleTask, conflictsFor, nowMadrid, dayLabel,
  addDays, toMin, fromMin,
} from "./brain.js";

const API = "https://api.telegram.org";
const MAX_TRANSCRIBE_SECONDS = 300;

export async function tg(env, method, payload) {
  const r = await fetch(`${API}/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export async function handleWebhook(request, env, ctx) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TG_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();
  // Responder rápido a Telegram y procesar en segundo plano
  ctx.waitUntil(processUpdate(update, env).catch((e) => console.error("webhook error:", e)));
  return new Response("ok");
}

async function processUpdate(update, env) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, env);
    if (update.message) return await handleMessage(update.message, env);
  } catch (e) {
    console.error("update error:", e?.stack || e);
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId && String(chatId) === String(env.OWNER_CHAT_ID)) {
      await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Algo ha fallado: ${String(e?.message || e).slice(0, 200)}
Prueba otra vez; si sigue, dímelo.` });
    }
  }
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;

  if (!env.OWNER_CHAT_ID) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Tu chat id es: ${chatId}\n\nConfigúralo para activar el bot:\nnpx wrangler secret put OWNER_CHAT_ID`,
    });
    return;
  }
  if (String(chatId) !== String(env.OWNER_CHAT_ID)) return; // bot privado

  const text = (msg.text || "").trim();

  // Asistente de X: /post (también como pie de una foto), /cita, /guardar, /radar.
  const command = (msg.text || msg.caption || "").trim();
  if (command.startsWith("/") && await socialCommand(env, chatId, command)) return;

  if (text === "/start" || text === "/ayuda") {
    // Menú de comandos de Telegram (el botón "/" junto al teclado).
    await tg(env, "setMyCommands", {
      commands: [
        { command: "hoy", description: "Agenda de hoy y huecos libres" },
        { command: "manana", description: "Agenda de mañana" },
        { command: "semana", description: "Huecos libres de 7 días" },
        { command: "lista", description: "Tareas pendientes" },
        { command: "planificar", description: "Colocar tareas sin hueco" },
        { command: "post", description: "Borrador de post para X" },
        { command: "radar", description: "Lo más caliente ahora para X" },
        { command: "cita", description: "Borrador para citar el N del radar" },
        { command: "guardar", description: "Guardar el N del radar para un hilo" },
        { command: "hilo", description: "Hilo con lo guardado" },
        { command: "ayuda", description: "Qué puedo hacer" },
      ],
    });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Soy tu asistente. Escríbeme o mándame un audio:\n\n" +
        "❓ Pregúntame\n• \"¿Qué tengo mañana?\" · \"¿Cuándo es el parcial de SO?\"\n• \"¿Tengo hueco el jueves por la tarde?\" · \"¿Qué ha dicho el profe de IS?\"\n\n" +
        "📥 Apunta\n• \"Reunión con Marco el jueves a las 17\" → evento\n• \"Hacer la práctica de SO antes del viernes\" → tarea en un hueco libre\n" +
        "• \"Parcial de Cálculo el 16/11 a las 10:45\" → examen\n• \"Este sábado no hay partido\" → lo quita del calendario\n\n" +
        "✏️ Cambia\n• \"El control de Cálculo lo pasan al 13 a las 10:45\"\n• \"Mueve la reunión con Marco a las 18\" · \"Borra la reunión del jueves\"\n• \"Ya entregué la práctica de EC\"\n\n" +
        "Fotos, archivos y notas también se guardan.\n\n" +
        "Comandos:\n/hoy — tu agenda de hoy y huecos\n/manana — la de mañana\n" +
        "/semana — huecos libres de 7 días\n/lista — tareas pendientes\n" +
        "/planificar — coloca las tareas que aún no tienen hueco\n\n" +
        "𝕏 Para X (no publico nada: te aviso cuando hay tema y escribo borradores):\n" +
        "/post idea → dos versiones de un post\n/radar → lo más caliente ahora\n" +
        "/cita N → comentario para citar el N del radar\n/guardar N → para un hilo · /hilo → escribirlo",
    });
    return;
  }
  if (text === "/lista") {
    await sendList(env, chatId, false);
    return;
  }
  if (text === "/hoy" || text === "/manana" || text === "/mañana") {
    const { date } = nowMadrid();
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: (await agendaText(env, text === "/hoy" ? date : addDays(date, 1))).slice(0, 4000),
    });
    return;
  }
  if (text === "/semana") {
    await tg(env, "sendMessage", { chat_id: chatId, text: (await weekFreeText(env)).slice(0, 4000) });
    return;
  }
  if (text === "/planificar") {
    await planAll(env, chatId);
    return;
  }

  // Adjuntos: foto, documento, audio, vídeo
  const file = pickFile(msg);

  // Texto: pregunta, cambio o algo que apuntar.
  if (!file && text && !text.startsWith("/") && await assistant(env, chatId, text)) return;
  const caption = (msg.caption || msg.text || "").trim() || null;

  if (file?.isAudio && !caption && (file.duration ?? 0) <= MAX_TRANSCRIBE_SECONDS) {
    const preBuffer = await fetchTelegramFile(env, file.file_id);
    const transcript = preBuffer ? await transcribe(env, preBuffer) : null;

    if (transcript && await assistant(env, chatId, transcript)) return;

    if (transcript) {
      // Extrae 1 o varias tareas/notas reales del audio (ignora saludos y relleno).
      // Si la extracción falla, cae al transcript completo como único item —
      // nunca se pierde lo que se dijo en el audio.
      let items = await classifyAudioTranscript(env, transcript);
      if (!items) items = [{ text: transcript, ...(await classify(env, transcript)) }];
      await saveAudioItems(env, chatId, file, preBuffer, transcript, items);
      return;
    }

    // No se pudo descargar o transcribir: cae a material, igual que antes
    await saveSingleItem(env, chatId, file, null, {
      kind: "material", priority: "normal", category: null, due_date: null,
    }, preBuffer);
    return;
  }

  const cls = file && !caption
    ? { kind: "material", priority: "normal", category: null, due_date: null }
    : await classify(env, caption || text);
  await saveSingleItem(env, chatId, file, caption || text || null, cls, null);
}

// Guarda el item y, si es evento o tarea, le da hora en la agenda. Devuelve { id, agenda }.
async function insertItem(env, rawText, cls) {
  // En el calendario queda mejor el título limpio ("Reunión con Marco") que el mensaje entero.
  const text = ["evento", "tarea", "examen", "cancelacion"].includes(cls.kind) && cls.title ? cls.title : rawText;
  let start = null, end = null;
  if ((cls.kind === "evento" || cls.kind === "examen") && cls.time) {
    const dur = cls.duration_min || (cls.kind === "examen" ? 90 : 60);
    start = `${cls.due_date}T${cls.time}`;
    end = `${cls.due_date}T${fromMin(Math.min(toMin(cls.time) + dur, 23 * 60 + 59))}`;
  }
  const res = await env.DB.prepare(
    `INSERT INTO items (kind, text, category, priority, due_date, start_at, end_at, duration_min, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(cls.kind, text, cls.category, cls.priority, cls.due_date, start, end,
    cls.duration_min ?? null, cls.location ?? null).run();
  const id = res.meta.last_row_id;

  let agenda = "";
  try {
    if (cls.kind === "examen") {
      const replaced = start ? replacedBy({ text, start_at: start, end_at: end }, await loadSessions(env)) : [];
      agenda = `\n📝 ${dayLabel(cls.due_date)}${start ? ` ${start.slice(11)}–${end.slice(11)}` : " (sin hora)"}` +
        (replaced.length ? `\nEn el calendario sustituye a: ${replaced.map((s) => `${s.subject} ${s.start}–${s.end}`).join(", ")}` : "");
    } else if (cls.kind === "cancelacion") {
      const gone = await cancellationEffect(env, text, cls.due_date);
      agenda = gone.length
        ? `\n❌ Quitado del ${dayLabel(cls.due_date)}: ${gone.join(", ")}`
        : `\n⚠️ No encuentro "${text}" el ${dayLabel(cls.due_date)}. Dime qué es (partido, entreno o la asignatura).`;
    } else if (cls.kind === "evento") {
      const hits = await conflictsFor(env, cls.due_date, start.slice(11), end.slice(11), id);
      agenda = `\n📅 ${dayLabel(cls.due_date)} ${start.slice(11)}–${end.slice(11)}` +
        (cls.location ? ` · ${cls.location}` : "") +
        (hits.length ? `\n⚠️ Choca con: ${hits.map((h) => `${h.label} (${h.shown || h.start}–${h.shownEnd || h.end})`).join(", ")}` : "");
    }
  } catch (e) {
    console.error("agenda error:", e?.message || e);
  }
  return { id, agenda };
}

async function placeTask(env, item, after = null) {
  const { slot, late } = await scheduleTask(env, item, after);
  if (!slot) return "\n🧠 No encuentro hueco libre en las próximas semanas";
  return `\n🧠 Te la pongo el ${dayLabel(slot.date)} ${slot.start}–${slot.end}` +
    (late ? `\n⚠️ No cabe antes de su fecha límite (${dayLabel(item.due_date)})` : "");
}

async function planAll(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM items WHERE status='pendiente' AND kind='tarea' AND start_at IS NULL AND priority!='algun_dia'
     ORDER BY CASE priority WHEN 'urgente' THEN 0 ELSE 1 END, due_date IS NULL, due_date, id`
  ).all();
  if (!results.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Todas tus tareas ya tienen hueco 👌" });
    return;
  }
  const lines = [];
  for (const it of results) {
    const { slot, late } = await scheduleTask(env, it);
    lines.push(slot
      ? `• #${it.id} ${it.text} → ${dayLabel(slot.date)} ${slot.start}–${slot.end}${late ? " ⚠️ tarde" : ""}`
      : `• #${it.id} ${it.text} → sin hueco`);
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `🧠 He colocado ${results.length} tareas:\n\n${lines.join("\n")}\n\nUsa 🔁 en cada una o el dashboard para moverlas.`.slice(0, 4000),
  });
}

async function saveSingleItem(env, chatId, file, effectiveText, cls, preBuffer) {
  const { id, agenda } = await insertItem(env, effectiveText, cls);

  let fileNote = "";
  if (file) {
    const saved = await saveAttachment(env, id, file, preBuffer);
    fileNote = saved ? "\n📎 archivo guardado" : "\n⚠️ no pude descargar el archivo";
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `📥 Guardada #${id}\n${summaryLine(cls)}${agenda}${fileNote}`,
    reply_markup: itemKeyboard(id, cls.kind),
  });
}

async function saveAudioItems(env, chatId, file, preBuffer, transcript, items) {
  for (let idx = 0; idx < items.length; idx++) {
    const cls = items[idx];
    const { id, agenda } = await insertItem(env, cls.text, cls);

    // Cada item se lleva su propia copia del audio en KV (evita que borrar
    // una tarea deje sin adjunto a las demás creadas del mismo audio).
    const saved = await saveAttachment(env, id, file, preBuffer);
    const fileNote = saved ? "\n📎 archivo guardado" : "\n⚠️ no pude descargar el archivo";
    const prefix = idx === 0 ? `🎙 "${transcript.slice(0, 150)}"\n\n` : "";

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${prefix}📥 Guardada #${id}\n${summaryLine(cls)}${agenda}${fileNote}`,
      reply_markup: itemKeyboard(id, cls.kind),
    });
  }
}

function pickFile(msg) {
  if (msg.photo?.length) {
    return { file_id: msg.photo[msg.photo.length - 1].file_id, mime: "image/jpeg" };
  }
  if (msg.document) return { file_id: msg.document.file_id, mime: msg.document.mime_type || "application/octet-stream" };
  if (msg.voice) return { file_id: msg.voice.file_id, mime: "audio/ogg", isAudio: true, duration: msg.voice.duration ?? 0 };
  if (msg.audio) return { file_id: msg.audio.file_id, mime: msg.audio.mime_type || "audio/mpeg", isAudio: true, duration: msg.audio.duration ?? 0 };
  if (msg.video) return { file_id: msg.video.file_id, mime: "video/mp4" };
  return null;
}

async function fetchTelegramFile(env, file_id) {
  try {
    const info = await tg(env, "getFile", { file_id });
    if (!info.ok) return null;
    const r = await fetch(`${API}/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch (e) {
    console.error("fetchTelegramFile error:", e?.message || e);
    return null;
  }
}

async function saveAttachment(env, itemId, file, preBuffer) {
  const buffer = preBuffer ?? await fetchTelegramFile(env, file.file_id);
  if (!buffer) return false;
  const key = `att/${crypto.randomUUID()}`;
  await env.FILES.put(key, buffer, { metadata: { mime: file.mime } });
  await env.DB.prepare("INSERT INTO attachments (item_id, r2_key, mime) VALUES (?, ?, ?)")
    .bind(itemId, key, file.mime).run();
  return true;
}

async function handleCallback(cb, env) {
  if (String(cb.from.id) !== String(env.OWNER_CHAT_ID)) return;
  const [action, idStr] = (cb.data || "").split(":");
  const id = Number(idStr);
  if (action.startsWith("x")) return socialCallback(env, cb, action, id);
  let notice = "";

  if (action === "done") {
    await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(id).run();
    notice = "✅ Hecha";
  } else if (action === "urg") {
    await env.DB.prepare("UPDATE items SET priority='urgente' WHERE id=?").bind(id).run();
    notice = "🔥 Marcada urgente";
  } else if (action === "sd") {
    // Algo de "algún día" deja de ocupar hueco en la agenda.
    await env.DB.prepare(
      `UPDATE items SET priority='algun_dia',
         start_at = CASE WHEN kind='tarea' THEN NULL ELSE start_at END,
         end_at = CASE WHEN kind='tarea' THEN NULL ELSE end_at END
       WHERE id=?`
    ).bind(id).run();
    notice = "🌙 Para algún día";
  } else if (action === "undo") {
    notice = await undoChange(env, id);
  } else if (action === "keep") {
    notice = "Vale, no lo borro";
  } else if (action === "mv") {
    const it = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first();
    if (it?.kind === "tarea") {
      // Siguiente hueco a partir del final del bloque actual.
      const after = it.end_at ? { date: it.end_at.slice(0, 10), time: it.end_at.slice(11, 16) } : null;
      const line = await placeTask(env, it, after);
      notice = "🔁 Movida";
      await tg(env, "sendMessage", { chat_id: cb.message.chat.id, text: `🔁 #${id} ${it.text}${line}` });
    }
  } else if (action === "del") {
    const it = await env.DB.prepare("SELECT kind FROM items WHERE id=?").bind(id).first();
    const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE item_id=?").bind(id).all();
    for (const a of atts.results) await env.FILES.delete(a.r2_key);
    await env.DB.prepare("DELETE FROM attachments WHERE item_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
    notice = it?.kind === "cancelacion" ? "↩️ Deshecho: vuelve a estar en tu calendario" : "🗑 Borrada";
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
  if (action === "done" || action === "del" || action === "undo" || action === "keep") {
    await tg(env, "editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: `${notice} #${id}`,
    });
  } else if (action !== "mv") {
    const it = await env.DB.prepare("SELECT kind FROM items WHERE id=?").bind(id).first();
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: itemKeyboard(id, it?.kind),
    });
  }
}

async function sendList(env, chatId, onlyToday) {
  const today = new Date().toISOString().slice(0, 10);
  let sql = "SELECT * FROM items WHERE status='pendiente' AND kind='tarea'";
  const binds = [];
  if (onlyToday) {
    sql += " AND due_date IS NOT NULL AND due_date <= ?";
    binds.push(today);
  }
  sql += " ORDER BY CASE priority WHEN 'urgente' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due_date IS NULL, due_date";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  if (!results.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: onlyToday ? "Nada vence hoy 👌" : "No hay tareas pendientes 🎉" });
    return;
  }
  const lines = results.map((i) => {
    const p = i.priority === "urgente" ? "🔥" : i.priority === "algun_dia" ? "🌙" : "▫️";
    const due = i.due_date ? ` (📅 ${i.due_date})` : "";
    const cat = i.category ? ` [${i.category}]` : "";
    return `${p} #${i.id} ${i.text}${cat}${due}`;
  });
  await tg(env, "sendMessage", { chat_id: chatId, text: lines.join("\n").slice(0, 4000) });
}

export function itemKeyboard(id, kind = "tarea") {
  if (kind === "cancelacion") {
    return { inline_keyboard: [[{ text: "↩️ Deshacer", callback_data: `del:${id}` }]] };
  }
  if (kind === "examen") {
    return { inline_keyboard: [[{ text: "🗑 Borrar", callback_data: `del:${id}` }]] };
  }
  if (kind === "evento") {
    return { inline_keyboard: [[{ text: "✅ Hecho", callback_data: `done:${id}` }, { text: "🗑 Borrar", callback_data: `del:${id}` }]] };
  }
  const rows = [
    [
      { text: "✅ Hecha", callback_data: `done:${id}` },
      { text: "🔥 Urgente", callback_data: `urg:${id}` },
    ],
    [
      { text: "🌙 Algún día", callback_data: `sd:${id}` },
      { text: "🗑 Borrar", callback_data: `del:${id}` },
    ],
  ];
  if (kind === "tarea") rows.unshift([{ text: "🔁 Otro hueco", callback_data: `mv:${id}` }]);
  return { inline_keyboard: rows };
}

export function summaryLine(cls) {
  const kind = {
    tarea: "📌 tarea", evento: "📅 evento", examen: "📝 examen", cancelacion: "❌ cancelación",
    nota: "🗒 nota", material: "📎 material",
  }[cls.kind];
  if (cls.kind === "cancelacion" || cls.kind === "examen") return kind;
  const prio = { urgente: "🔥 urgente", normal: "▫️ normal", algun_dia: "🌙 algún día" }[cls.priority];
  const parts = [kind, prio];
  if (cls.category) parts.push(`🏷 ${cls.category}`);
  if (cls.due_date && cls.kind !== "evento") parts.push(`📅 vence ${dayLabel(cls.due_date)}`);
  if (cls.kind === "tarea" && cls.duration_min) parts.push(`⏱ ${cls.duration_min} min`);
  return parts.join(" · ");
}
