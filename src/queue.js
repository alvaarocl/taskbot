// Mensajes en espera: si no queda cuota de IA (10.000 neuronas al día en Workers AI, o el límite de Groq),
// el mensaje o el audio se guardan aquí en vez de apuntarse mal, y el bot avisa de cuándo los procesará.
// El cron de cada hora (:15) los vuelve a intentar en orden; en cuanto falla uno por cuota, para.

import { tg } from "./telegram.js";
import { transcribe } from "./classify.js";
import { QuotaError } from "./llm.js";

const KEY = "queue:msgs";
const MAX_PER_RUN = 3; // cada uno son varias llamadas al modelo: no pasar del límite de subpeticiones del cron
const KEEP_DAYS = 7;

const load = async (env) => (await env.FILES.get(KEY, { type: "json" })) || [];
const save = (env, list) => env.FILES.put(KEY, JSON.stringify(list));

// La cuota de Workers AI vuelve a las 00:00 UTC: en Madrid, las 2:00 en verano y la 1:00 en invierno.
function resetMadrid() {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "numeric", minute: "2-digit" }).format(next);
}

export async function enqueue(env, chatId, entry) {
  const list = await load(env);
  list.push({ ...entry, at: new Date().toISOString() });
  await save(env, list);
  const what = entry.audio ? "tu audio" : "tu mensaje";
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `⏳ Me he quedado sin IA gratis por hoy. Me guardo ${what} y lo proceso en cuanto vuelva (sobre las ${resetMadrid()}); te contesto entonces.`,
  });
}

export async function enqueueAudio(env, chatId, buffer, mime) {
  const key = `queue/${crypto.randomUUID()}`;
  await env.FILES.put(key, buffer, { metadata: { mime }, expirationTtl: KEEP_DAYS * 86400 });
  await enqueue(env, chatId, { audio: key, mime });
}

/** Cron: intenta lo que haya en espera. `agent` se pasa para no crear un ciclo de imports. */
export async function processQueue(env, agent) {
  let list = await load(env);
  if (!list.length || !env.OWNER_CHAT_ID) return;
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  list = list.filter((m) => Date.parse(m.at) > cutoff);

  for (let n = 0; n < MAX_PER_RUN && list.length; n++) {
    const m = list[0];
    // Fecha completa: "mañana" se refiere al día en que lo mandó, no al de ahora.
    const when = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(m.at));
    try {
      let text = m.text;
      if (m.audio) {
        const buf = await env.FILES.get(m.audio, { type: "arrayBuffer" });
        text = buf ? await transcribe(env, buf, m.mime) : null;
        if (!text) {
          await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: `⚠️ No he podido entender el audio que me mandaste (${when}). ¿Me lo escribes?` });
        }
        text = text && `(audio transcrito) ${text}`;
      }
      if (text) {
        const done = await agent(env, env.OWNER_CHAT_ID, `(Me lo mandó el ${when} y no pude atenderlo por falta de cuota: las fechas relativas como "mañana" van respecto a ese día) ${text}`, { queued: true });
        if (done === "quota") break;
      }
    } catch (e) {
      if (e instanceof QuotaError) break; // sigue sin cuota: se queda en la cola
      console.error("queue", e?.message || e);
    }
    if (m.audio) await env.FILES.delete(m.audio);
    list.shift();
  }
  await save(env, list);
}
