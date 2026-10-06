import { handleWebhook } from "./telegram.js";
import { handleApi } from "./api.js";
import { runReminders, notifyReplan } from "./reminders.js";
import { handleCalendar, handleScheduleFeed } from "./calendar.js";
import { syncUc3m } from "./sync.js";

// Debe coincidir con el segundo cron de wrangler.toml.
const SYNC_CRON = "30 */3 * * *";

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
    // Primero el horario de la UC3M; luego se recolocan las tareas que ahora choquen.
    if (event.cron === SYNC_CRON) ctx.waitUntil(syncUc3m(env).finally(() => notifyReplan(env)));
    else ctx.waitUntil(runReminders(env));
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
