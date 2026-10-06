import { fetchSchedule } from "./uc3m.js";
import { tg } from "./telegram.js";

// La última versión del horario se guarda en KV (una sola clave: lectura y escritura baratas).
const KEY = "uc3m:sessions";

export async function loadSessions(env) {
  return (await env.FILES.get(KEY, { type: "json" })) || [];
}

// Cron: vuelve a leer la web de horarios y avisa por Telegram de lo que haya cambiado.
export async function syncUc3m(env) {
  const next = await fetchSchedule();
  const prev = await loadSessions(env);

  // Si la web de la UC3M falla o devuelve media página, no machacamos el calendario bueno.
  if (next.length === 0 || (prev.length && next.length < prev.length * 0.6)) {
    console.warn(`horarios UC3M sospechosos: ${next.length} sesiones (antes ${prev.length})`);
    return;
  }

  const changes = diffSessions(prev, next, today());
  if (prev.length && !changes.length) return;
  await env.FILES.put(KEY, JSON.stringify(next));

  if (prev.length && changes.length && env.OWNER_CHAT_ID) {
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_CHAT_ID,
      text: formatChanges(changes).slice(0, 4000),
    });
  }
}

// Solo cuenta lo que aún no ha pasado. Misma clave con otra aula = cambio de aula.
export function diffSessions(prev, next, fromDate) {
  const a = new Map(prev.filter((s) => s.date >= fromDate).map((s) => [s.key, s]));
  const b = new Map(next.filter((s) => s.date >= fromDate).map((s) => [s.key, s]));
  const out = [];
  for (const [k, s] of b) {
    if (!a.has(k)) out.push({ kind: "nueva", s });
    else if (a.get(k).room !== s.room || a.get(k).end !== s.end) out.push({ kind: "aula", s, before: a.get(k) });
  }
  for (const [k, s] of a) if (!b.has(k)) out.push({ kind: "quitada", s });
  return out.sort((x, y) => (x.s.date + x.s.start).localeCompare(y.s.date + y.s.start));
}

export function formatChanges(changes) {
  const icon = { nueva: "➕", quitada: "❌", aula: "🔁" };
  const lines = changes.slice(0, 25).map(({ kind, s, before }) => {
    const when = `${dayLabel(s.date)} ${s.start}`;
    const what = `${s.subject} (${typeLabel(s.type)})`;
    if (kind === "aula") return `${icon.aula} ${when} · ${what}: ${before.room} → ${s.room}`;
    if (kind === "quitada") return `${icon.quitada} ${when} · ${what} ya no está`;
    return `${icon.nueva} ${when} · ${what} en ${s.room}`;
  });
  const more = changes.length > 25 ? `\n…y ${changes.length - 25} más` : "";
  return `🎓 Cambios en tu horario UC3M:\n\n${lines.join("\n")}${more}`;
}

export function typeLabel(t) {
  return t.charAt(0) + t.slice(1).toLowerCase();
}

const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
function dayLabel(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}
