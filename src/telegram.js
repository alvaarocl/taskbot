import { classify, transcribe, classifyAudioTranscript } from "./classify.js";

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
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
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

  if (text === "/start" || text === "/ayuda") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "📥 Mándame cualquier cosa y la guardo:\n" +
        "• Texto → tarea o nota (clasifico solo)\n" +
        "• Fotos, archivos, audios → material guardado\n\n" +
        "Comandos:\n/lista — pendientes\n/hoy — lo que vence hoy",
    });
    return;
  }
  if (text === "/lista" || text === "/hoy") {
    await sendList(env, chatId, text === "/hoy");
    return;
  }

  // Adjuntos: foto, documento, audio, vídeo
  const file = pickFile(msg);
  const caption = (msg.caption || msg.text || "").trim() || null;

  if (file?.isAudio && !caption && (file.duration ?? 0) <= MAX_TRANSCRIBE_SECONDS) {
    const preBuffer = await fetchTelegramFile(env, file.file_id);
    const transcript = preBuffer ? await transcribe(env, preBuffer) : null;

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

async function saveSingleItem(env, chatId, file, effectiveText, cls, preBuffer) {
  const res = await env.DB.prepare(
    "INSERT INTO items (kind, text, category, priority, due_date) VALUES (?, ?, ?, ?, ?)"
  ).bind(cls.kind, effectiveText, cls.category, cls.priority, cls.due_date).run();
  const id = res.meta.last_row_id;

  let fileNote = "";
  if (file) {
    const saved = await saveAttachment(env, id, file, preBuffer);
    fileNote = saved ? "\n📎 archivo guardado" : "\n⚠️ no pude descargar el archivo";
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `📥 Guardada #${id}\n${summaryLine(cls)}${fileNote}`,
    reply_markup: itemKeyboard(id),
  });
}

async function saveAudioItems(env, chatId, file, preBuffer, transcript, items) {
  for (let idx = 0; idx < items.length; idx++) {
    const cls = items[idx];
    const res = await env.DB.prepare(
      "INSERT INTO items (kind, text, category, priority, due_date) VALUES (?, ?, ?, ?, ?)"
    ).bind(cls.kind, cls.text, cls.category, cls.priority, cls.due_date).run();
    const id = res.meta.last_row_id;

    // Cada item se lleva su propia copia del audio en KV (evita que borrar
    // una tarea deje sin adjunto a las demás creadas del mismo audio).
    const saved = await saveAttachment(env, id, file, preBuffer);
    const fileNote = saved ? "\n📎 archivo guardado" : "\n⚠️ no pude descargar el archivo";
    const prefix = idx === 0 ? `🎙 "${transcript.slice(0, 150)}"\n\n` : "";

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${prefix}📥 Guardada #${id}\n${summaryLine(cls)}${fileNote}`,
      reply_markup: itemKeyboard(id),
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
  let notice = "";

  if (action === "done") {
    await env.DB.prepare("UPDATE items SET status='hecha', done_at=datetime('now') WHERE id=?").bind(id).run();
    notice = "✅ Hecha";
  } else if (action === "urg") {
    await env.DB.prepare("UPDATE items SET priority='urgente' WHERE id=?").bind(id).run();
    notice = "🔥 Marcada urgente";
  } else if (action === "sd") {
    await env.DB.prepare("UPDATE items SET priority='algun_dia' WHERE id=?").bind(id).run();
    notice = "🌙 Para algún día";
  } else if (action === "del") {
    const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE item_id=?").bind(id).all();
    for (const a of atts.results) await env.FILES.delete(a.r2_key);
    await env.DB.prepare("DELETE FROM attachments WHERE item_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
    notice = "🗑 Borrada";
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
  if (action === "done" || action === "del") {
    await tg(env, "editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: `${notice} #${id}`,
    });
  } else {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: itemKeyboard(id),
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

function itemKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Hecha", callback_data: `done:${id}` },
        { text: "🔥 Urgente", callback_data: `urg:${id}` },
      ],
      [
        { text: "🌙 Algún día", callback_data: `sd:${id}` },
        { text: "🗑 Borrar", callback_data: `del:${id}` },
      ],
    ],
  };
}

export function summaryLine(cls) {
  const kind = { tarea: "📌 tarea", nota: "📝 nota", material: "📎 material" }[cls.kind];
  const prio = { urgente: "🔥 urgente", normal: "▫️ normal", algun_dia: "🌙 algún día" }[cls.priority];
  const parts = [kind, prio];
  if (cls.category) parts.push(`🏷 ${cls.category}`);
  if (cls.due_date) parts.push(`📅 ${cls.due_date}`);
  return parts.join(" · ");
}
