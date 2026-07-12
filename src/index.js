import { handleWebhook } from "./telegram.js";
import { handleApi } from "./api.js";
import { runReminders } from "./reminders.js";
import { handleCalendar } from "./calendar.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname.startsWith("/files/")) return serveFile(url, env);
    if (url.pathname === "/calendar.ics") return handleCalendar(url, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
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
