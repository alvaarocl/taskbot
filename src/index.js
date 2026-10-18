import config from "../config.js";
import { proactiveTick } from "./proactive.js";
import { handleRuntime, cleanRuntime } from "./runtime.js";
import { runSync } from "./freshness.js";
import { loadBusy } from "./brain.js";
import { localEpoch } from "./time.js";
import { handleWebhook } from "./telegram.js";
import { handleApi } from "./api.js";
import { runReminders } from "./reminders.js";
import { handleCalendar, handleScheduleFeed } from "./calendar.js";
import { syncUc3m } from "./sync.js";
import { syncAulaGlobal, syncAulaMaterial } from "./aulaglobal.js";
import { hourlySocial } from "./social.js";
import { handleAuth, requireAuth, panelOrigin, purgeAuth } from "./auth.js";
import { handleInbox, purgeInbox } from "./inbox.js";
import { buildWeekly } from "./weekly.js";
import { agent } from "./agent.js";
import { processQueue } from "./queue.js";
import { fetchEvents, syncNotionTasks } from "./notion.js";
import { wakeTick, jarvisReport, jarvisJob, jarvisTurn } from "./wake.js";
import { handleEmail, retryMail } from "./mail.js";
import { nightlyHealth } from "./health.js";
import { eveningClose } from "./evening.js";

// Deben coincidir con los crons de wrangler.toml. La cuenta gratuita permite 5 crons en total
// (entre todos los workers), así que el de "45" reparte el trabajo según la hora.
const AULA_CRON = "15 * * * *"; // cada hora: entregas, recordatorios y avisos de Aula Global
const SPLIT_CRON = "45 * * * *"; // cada hora: asistente de X, y horario UC3M (h % 3 = 0) o material y notas (h % 3 = 1);
// a las 7:45 de Madrid, además, los buenos días (va aquí y no en un cron propio: la cuenta gratis tiene 5 entre todos los workers)
const MORNING_HOUR_MADRID = 7;
const PURGE_HOUR_MADRID = 4; // limpieza diaria: sesiones caducadas y mensajes de más de 90 días
const WEEKLY_HOUR_MADRID = 20; // domingo a las 20:45: resumen semanal

// En workers.dev solo quedan las rutas de máquinas (feeds del calendario, webhook, API con token y archivos);
// lo que es panel redirige a su dominio, que es donde valen las passkeys.
const MACHINE_ROUTES = /^\/(api\/|files\/|cal\/|calendar\.ics$|webhook$)/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Solo si el panel vive en otro dominio (sin dominio propio, el panel es el propio workers.dev).
    if (url.hostname.endsWith(".workers.dev") && url.origin !== panelOrigin(env) && !MACHINE_ROUTES.test(url.pathname)) {
      return Response.redirect(panelOrigin(env) + url.pathname + url.search, 302);
    }
    if (url.pathname.startsWith("/api/runtime/")) return handleRuntime(request,env);
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname.startsWith("/auth/")) return handleAuth(request, env);
    if (url.pathname === "/internal/busy") {
      if (url.hostname !== "internal" || request.method !== "GET") return new Response("not found", {status:404});
      const from=url.searchParams.get('from'), to=url.searchParams.get('to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from||'') || !/^\d{4}-\d{2}-\d{2}$/.test(to||'') || to<from || Date.parse(to)-Date.parse(from)>35*86400000) return Response.json({error:'range'},{status:400});
      const blocks=await loadBusy(env,from,to,null,false);
      return Response.json({busy:blocks.filter(b=>!b.soft).map(b=>({start:localEpoch(b.date,b.start),end:b.end==='24:00'?localEpoch(new Date(Date.parse(b.date+'T12:00Z')+86400000).toISOString().slice(0,10)):localEpoch(b.date,b.end)}))});
    }
    // Mensajes y reservas que empuja el worker `api` por su service binding (host "internal", solo existe por ahí).
    if (url.pathname === "/internal/inbox") return url.hostname === "internal" ? handleInbox(request, env) : new Response("not found", { status: 404 });
    // El workflow de Jarvis avisa de cómo fue la llamada (su propio token, no el del panel).
    if (url.pathname === "/api/jarvis/turn" && request.method === "POST") {
      if(config.runtime?.voice)return new Response('legacy transport disabled',{status:410});
      if (!env.JARVIS_TOKEN || request.headers.get("authorization") !== `Bearer ${env.JARVIS_TOKEN}`) return new Response("unauthorized", { status: 401 });
      return Response.json(await jarvisTurn(env, await request.json().catch(() => null)));
    }
    if (url.pathname === "/api/jarvis") {
      if(config.runtime?.voice)return new Response('legacy transport disabled',{status:410});
      if (!env.JARVIS_TOKEN || request.headers.get("authorization") !== `Bearer ${env.JARVIS_TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (request.method === "GET") return Response.json(await jarvisJob(env, url.searchParams.get("job")) || { error: "not found" });
      return Response.json(await jarvisReport(env, await request.json().catch(() => null)));
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname.startsWith("/files/")) return serveFile(request, url, env);
    if (url.pathname === "/calendar.ics") return handleCalendar(url, env);
    if (url.pathname.startsWith("/cal/")) return handleScheduleFeed(url, env);
    if (url.pathname.startsWith("/brand/")) return withSecurityHeaders(await brandAsset(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  // Correo que reenvían tus cuentas a config.mail.address (Cloudflare Email Routing → este worker).
  async email(message, env, ctx) {
    await handleEmail(message, env).catch((e) => console.error("correo", e?.stack || e));
  },

  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime);
    const hour = at.getUTCHours();
    const madridHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(at));
    if (event.cron === AULA_CRON) {
      // Chequeo de salud (~6 peticiones): una vez por la noche, solo escribe si algo falla.
      if (config.health && madridHour === (config.health.hour ?? 21)) ctx.waitUntil(nightlyHealth(env).catch((e) => console.error("salud", e?.message || e)));
      ctx.waitUntil(runSync(env,"aula:tareas",()=>syncAulaGlobal(env)));
      ctx.waitUntil(processQueue(env, agent).catch((e) => console.error("cola", e?.message || e))); // mensajes en espera por falta de cuota
      ctx.waitUntil(proactiveTick(env).catch((e)=>console.error("proactive",e?.name)));
      ctx.waitUntil(wakeTick(env, event.scheduledTime).catch((e) => console.error("jarvis", e?.message || e)));
      ctx.waitUntil(retryMail(env).catch((e) => console.error("correo", e?.message || e))); // correos que esperaban a la IA
    }
    else if (event.cron === SPLIT_CRON) {
      const sunday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short" }).format(at) === "Sun";
      if (madridHour === MORNING_HOUR_MADRID) ctx.waitUntil(runReminders(env));
      if (madridHour === PURGE_HOUR_MADRID) ctx.waitUntil(Promise.all([purgeAuth(env), purgeInbox(env), cleanRuntime(env)]));
      const weekly = !!config.weekly && sunday && madridHour === WEEKLY_HOUR_MADRID;
      // Cierre del día: lo que ha quedado pendiente, con botones para pasarlo a mañana.
      if (config.evening && madridHour === (config.evening.hour ?? 22)) ctx.waitUntil(eveningClose(env).catch((e) => console.error("cierre", e?.message || e)));
      if (weekly) ctx.waitUntil(buildWeekly(env).catch((e) => console.error("resumen semanal", e?.stack || e)));
      // Máximo 50 peticiones externas por ejecución: el horario usa ~4, material y notas ~15 y el asistente de X ~14 (~18 cuando toca Trending por lenguajes o eventos).
      if (hour % 3 === 0) ctx.waitUntil(runSync(env,"uc3m:horario",()=>syncUc3m(env)));
      else if (hour % 3 === 1) ctx.waitUntil(runSync(env,"aula:material",()=>syncAulaMaterial(env)));
      ctx.waitUntil(proactiveTick(env).catch((e)=>console.error("proactive",e?.name)));
      ctx.waitUntil(wakeTick(env, event.scheduledTime).catch((e) => console.error("jarvis", e?.message || e)));
      // Notion: eventos al día (agenda y calendario) y tareas asignadas a ti (~4 peticiones).
      ctx.waitUntil(runSync(env,"notion",()=>fetchEvents(env).then(()=>syncNotionTasks(env))));
      // El resumen gasta ~10 peticiones de GitHub: ese tick se salta el asistente de X para no pasar de 50.
      if (!weekly) ctx.waitUntil(hourlySocial(env));
    } else console.warn("cron desconocido:", event.cron);
  },
};

// El panel solo carga cosas de su propio origen: ni scripts de fuera, ni iframes, ni referrer.
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// Logo e iconos: los tuyos si tienes public/brand/ (no se sube a git); si no, los neutros de public/brand.default/.
// Un asset que no existe devuelve el index.html de la SPA, así que se mira el tipo además del estado.
async function brandAsset(request, env, url) {
  const own = await env.ASSETS.fetch(request);
  if (own.ok && !(own.headers.get("content-type") || "").includes("text/html")) return own;
  return env.ASSETS.fetch(new Request(new URL(url.pathname.replace("/brand/", "/brand.default/"), url), request));
}

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function serveFile(request, url, env) {
  // Cookie del panel o, por compatibilidad con enlaces antiguos, ?t=DASH_TOKEN.
  const tokenOk = env.DASH_TOKEN && url.searchParams.get("t") === env.DASH_TOKEN;
  if (!tokenOk && !await requireAuth(request, env)) {
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
