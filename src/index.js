import { handleWebhook } from "./telegram.js";
import { handleApi } from "./api.js";
import { runReminders } from "./reminders.js";
import { handleCalendar, handleScheduleFeed } from "./calendar.js";
import { syncUc3m } from "./sync.js";
import { syncAulaGlobal, syncAulaMaterial } from "./aulaglobal.js";
import { hourlySocial } from "./social.js";

// Deben coincidir con los crons de wrangler.toml. La cuenta gratuita permite 5 crons en total
// (entre todos los workers), así que el de "45" reparte el trabajo según la hora.
const MORNING_CRON = "0 6 * * *"; // buenos días: agenda del día
const AULA_CRON = "15 * * * *"; // cada hora: entregas, recordatorios y avisos de Aula Global
const SPLIT_CRON = "45 * * * *"; // cada hora: asistente de X, y horario UC3M (h % 3 = 0) o material y notas (h % 3 = 1)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname.startsWith("/files/")) return serveFile(url, env);
    if (url.pathname === "/calendar.ics") return handleCalendar(url, env);
    if (url.pathname.startsWith("/cal/")) return handleScheduleFeed(url, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (event.cron === MORNING_CRON) ctx.waitUntil(runReminders(env));
    else if (event.cron === AULA_CRON) ctx.waitUntil(syncAulaGlobal(env));
    else if (event.cron === SPLIT_CRON) {
      // Máximo 50 peticiones externas por ejecución: el horario usa ~4, material y notas ~15 y el asistente de X ~14 (~18 cuando toca Trending por lenguajes o eventos).
      if (hour % 3 === 0) ctx.waitUntil(syncUc3m(env));
      else if (hour % 3 === 1) ctx.waitUntil(syncAulaMaterial(env));
      ctx.waitUntil(hourlySocial(env));
    } else console.warn("cron desconocido:", event.cron);
  },
};

async function serveFile(url, env) {
  if (url.searchParams.get("t") !== env.DASH_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const key = decodeURIComponent(url.pathname.slice("/files/".length));
  const { value, metadata } = await env.FILES.getWithMetadata(key, { type: "stream" });
  if (!value) return new Response("not found", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": metadata?.mime || "application/octet-stream",
      "cache-control": "private, max-age=31536000",
    },
  });
}
