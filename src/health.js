// Chequeo de salud (opcional, config.health). Cada noche comprueba que lo conectado sigue funcionando y solo te
// escribe si algo falla, con cómo arreglarlo: así te enteras antes de que mañana no suene Jarvis o no llegue un aviso.
// /salud lo hace en el momento y enseña todo, también lo que va bien.
//
// Aula Global no se mira aquí: ya avisa sola cuando caduca su acceso (src/aulaglobal.js).

import config from "../config.js";
import { runtimeStatus, runtimeEnabled } from "./runtime.js";
import { syncStatus } from "./freshness.js";
import { tg } from "./telegram.js";
import { notionOn } from "./notion.js";
import { jarvisOn } from "./wake.js";
import { gmailStatus, gmailEnabled } from "./gmail.js";

const TIMEOUT_MS = 20000;
const QUEUE_STUCK_HOURS = 6;

async function get(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const ok = (name, detail = "") => ({ name, ok: true, detail });
const fail = (name, detail, fix) => ({ name, ok: false, detail, fix });

const CHECKS = {
  async gmail(env) {
    if(!gmailEnabled(env))return null;
    const state=await gmailStatus(env,{verify:true});
    const unavailable=state.accounts.filter(a=>!a.connected || !a.readable);
    return state.error || unavailable.length ? fail('Correo',state.error || unavailable.map(a=>a.account).join(', '),'Revisa el consentimiento de la cuenta y Gmail API.') : ok('Correo',state.accounts.map(a=>a.account).join(' y '));
  },
  async runtime(env) {
    if (!runtimeEnabled(env)) return null;
    const state=await runtimeStatus(env);
    if(state.online && config.runtime?.voice && !state.voice)return fail('Voz de Jarvis','pendiente de autorización o conexión','Completa Autorizar Jarvis en el Mac. Obsidian sigue disponible.');
    return state.online ? ok('Servicio personal',state.voice?'Obsidian y voz':'Obsidian; voz desactivada') : fail('Servicio personal','sin conexión','Arranca el servicio en el equipo configurado. Las funciones locales no están disponibles.');
  },
  async freshness(env) {
    const states=await syncStatus(env);
    const stale=states.filter(s=>s.error || !s.success_at || Date.now()-Date.parse(s.success_at)>4*3600000);
    return stale.length ? fail('Sincronizaciones',stale.map(s=>s.source).join(', '),'Consulta servicio_estado para ver fechas y errores.') : ok('Sincronizaciones',states.length+' fuentes registradas');
  },
  // Telegram no consigue entregar los mensajes al bot (worker caído, webhook mal registrado…).
  async telegram(env) {
    const r = await (await get(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getWebhookInfo`)).json();
    if (!r.ok) return fail("Telegram", "el token del bot no vale", "Revisa TELEGRAM_TOKEN (npx wrangler secret put TELEGRAM_TOKEN).");
    const w = r.result;
    if (!w.url) return fail("Telegram", "no hay webhook registrado", "Vuelve a registrar el webhook (DEPLOY.md, paso del webhook).");
    const recent = w.last_error_date && Date.now() / 1000 - w.last_error_date < 6 * 3600;
    if (recent) return fail("Telegram", `error al entregar mensajes: ${w.last_error_message}`, "Comprueba que el worker está desplegado (npx wrangler deploy) y que TG_WEBHOOK_SECRET coincide con el del webhook.");
    if (w.pending_update_count > 10) return fail("Telegram", `${w.pending_update_count} mensajes sin entregar`, "El worker no está respondiendo: mira los registros con npx wrangler tail.");
    return ok("Telegram");
  },

  async groq(env) {
    if (!env.GROQ_API_KEY) return null;
    const r = await get("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${env.GROQ_API_KEY}` } });
    if (r.status === 401 || r.status === 403) return fail("Groq", "la clave no vale", "Crea otra en console.groq.com/keys y guárdala con npx wrangler secret put GROQ_API_KEY. Mientras, el asistente tira de Workers AI.");
    if (!r.ok) return fail("Groq", `responde ${r.status}`, "Suele ser pasajero; si sigue mañana, mira status.groq.com.");
    return ok("Groq");
  },

  async notion(env) {
    if (!notionOn(env)) return null;
    const r = await get("https://api.notion.com/v1/users/me", { headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": "2026-03-11" } });
    if (r.status === 401) return fail("Notion", "el token no vale", "Crea otro en notion.so/profile/integrations y guárdalo con npx wrangler secret put NOTION_TOKEN.");
    if (!r.ok) return fail("Notion", `responde ${r.status}`, "Comprueba que la conexión sigue teniendo acceso a las bases (··· → Conexiones).");
    return ok("Notion");
  },

  async aula(env) {
    if (!config.aulaGlobal) return null;
    const expired = await env.FILES.get("ag:token-alert"); // lo pone src/aulaglobal.js cuando el token caduca
    return expired
      ? { ...fail(config.aulaGlobal.name || "Moodle", "el acceso ha caducado", "Saca un token nuevo y guárdalo con npx wrangler secret put AULAGLOBAL_TOKEN (DEPLOY.md)."), alreadyAlerted: true }
      : ok(config.aulaGlobal.name || "Moodle");
  },

  // Mensajes guardados por falta de cuota que no salen.
  async queue(env) {
    const list = (await env.FILES.get("queue:msgs", { type: "json" })) || [];
    if (!list.length) return ok("Cola de mensajes", "vacía");
    const hours = (Date.now() - Date.parse(list[0].at)) / 3600000;
    if (hours > QUEUE_STUCK_HOURS) return fail("Cola de mensajes", `${list.length} esperando desde hace ${Math.round(hours)} h`, "La IA lleva horas sin cuota o falla: mira los registros con npx wrangler tail.");
    return ok("Cola de mensajes", `${list.length} esperando`);
  },

  async jarvisGithub(env) {
    if (config.runtime?.voice || !jarvisOn(env)) return null;
    const r = await get(`https://api.github.com/repos/${config.jarvis.repo}`, {
      headers: { authorization: `Bearer ${env.JARVIS_GH_TOKEN}`, "user-agent": "taskbot", accept: "application/vnd.github+json" },
    });
    if (r.status === 401) return fail("Jarvis · GitHub", "el token ha caducado o no vale", `Crea otro (permiso de Actions en ${config.jarvis.repo}) y guárdalo con npx wrangler secret put JARVIS_GH_TOKEN.`);
    if (!r.ok) return fail("Jarvis · GitHub", `responde ${r.status}`, `Comprueba que el token ve el repo ${config.jarvis.repo}.`);
    return ok("Jarvis · GitHub");
  },

  // La voz natural (Modal) y la sesión de la cuenta de Telegram que llama: si se cierra, Jarvis no puede llamar.
  async jarvisModal(env) {
    if (config.runtime?.voice || !jarvisOn(env) || !config.jarvis.modalUrl) return null;
    let j;
    try {
      const r = await get(config.jarvis.modalUrl.replace("-start.", "-health."), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: env.JARVIS_TOKEN }),
      });
      j = await r.json();
    } catch (e) {
      return fail("Jarvis · Modal", `no responde (${String(e?.message || e).slice(0, 80)})`, "Jarvis llamará con la voz de GitHub. Vuelve a desplegar: modal deploy jarvis/modal_app.py.");
    }
    if (j?.error) return fail("Jarvis · Modal", j.error, "JARVIS_TOKEN en Cloudflare y REPORT_TOKEN en Modal tienen que ser iguales.");
    if (!j?.telegram) return fail("Jarvis · Telegram", "la sesión de la cuenta que llama se ha cerrado", `Vuelve a entrar: python3 jarvis/login.py ${config.jarvis.repo}, y lanza el workflow sync-modal de ese repo.`);
    return ok("Jarvis", "Modal y la cuenta de Telegram");
  },
};

export async function runChecks(env) {
  const results = await Promise.all(Object.entries(CHECKS).map(async ([key, check]) => {
    try {
      return await check(env);
    } catch (e) {
      return fail(key, `no se ha podido comprobar (${String(e?.message || e).slice(0, 80)})`, "Si se repite mañana, mira los registros con npx wrangler tail.");
    }
  }));
  return results.filter(Boolean);
}

const failLine = (r) => `❌ ${r.name}: ${r.detail}\n   → ${r.fix}`;

/** Cron nocturno: solo escribe si algo falla (y no avisa otra vez de lo que ya avisa su módulo). */
export async function nightlyHealth(env) {
  if (!config.health || !env.OWNER_CHAT_ID) return;
  const bad = (await runChecks(env)).filter((r) => !r.ok && !r.alreadyAlerted);
  console.log(`[salud] ${bad.length ? bad.map((r) => r.name).join(", ") : "todo bien"}`);
  if (!bad.length) return;
  await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID,
    text: `🩺 Algo no va bien:\n\n${bad.map(failLine).join("\n\n")}`.slice(0, 4000),
    link_preview_options: { is_disabled: true },
  });
}

/** /salud: todo, lo que va y lo que no. */
export async function healthReport(env) {
  const results = await runChecks(env);
  const lines = results.map((r) => (r.ok ? `✅ ${r.name}${r.detail ? ` (${r.detail})` : ""}` : failLine(r)));
  return `🩺 Estado\n\n${lines.join("\n")}`;
}
