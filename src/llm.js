// Modelo del asistente: gpt-oss-120b (abierto, razonamiento y herramientas), gratis.
// 1) Groq (secreto GROQ_API_KEY): rápido y con cupo propio; los tokens en caché no cuentan.
// 2) Si Groq falla o se queda sin cupo: el mismo modelo en Workers AI (gasta neuronas del cupo diario).
// Los dos hablan el formato de chat de OpenAI (messages + tools), así que el bucle del agente no cambia.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// En el plan gratuito cada modelo tiene su propio cupo (8.000 tokens/min): si uno se agota, se pasa al otro.
const GROQ_MODELS = {
  smart: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  fast: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
};
// Qwen no entiende el nivel de razonamiento de gpt-oss: se le apaga y se le esconde el razonamiento.
const forModel = (model, body) => (model.startsWith("qwen/")
  ? (({ reasoning_effort, ...rest }) => ({ ...rest, reasoning_effort: "none", reasoning_format: "hidden" }))(body)
  : body);
const CF_MODEL = "@cf/openai/gpt-oss-120b";
const TIMEOUT_MS = 45000;

// "Sin cuota": Workers AI agota las 10.000 neuronas gratis del día (error 4006) o Groq su límite (429).
export const isQuota = (e) => /4006|daily free allocation|rate_limit_exceeded|Groq 429/i.test(String(e?.message || e));

export class QuotaError extends Error {}

// Workers AI rechaza `content: null` y campos extra en el mensaje del asistente: se deja lo justo.
export function cleanMessage(m) {
  const out = { role: "assistant", content: m?.content || "" };
  if (m?.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((c) => ({
      id: c.id, type: "function",
      function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
    }));
  }
  return out;
}

async function groq(env, model, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, ...body }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Una vuelta de chat. Devuelve { message, provider } con el mensaje del asistente ya limpio
 * (content + tool_calls). Lanza si fallan los dos proveedores.
 */
// `prefer`: "smart" (Telegram: el modelo grande primero) o "fast" (llamada de voz: el pequeño, más rápido, primero).
// `slowFallback`: si Groq falla, probar Workers AI (tarda 5–20 s). En una llamada de voz es mejor fallar rápido.
export async function chat(env, { messages, tools, effort = "medium", maxTokens = 4000, prefer = "smart", slowFallback = true }) {
  const body = { messages, max_tokens: maxTokens, reasoning_effort: effort };
  if (tools?.length) Object.assign(body, { tools, tool_choice: "auto" });

  const errors = [];
  if (env.GROQ_API_KEY) {
    for (const model of GROQ_MODELS[prefer] || GROQ_MODELS.smart) {
      try {
        const j = await groq(env, model, forModel(model, body));
        console.log(`[llm] groq ${model} ${j.usage?.prompt_tokens} in / ${j.usage?.completion_tokens} out · caché ${j.usage?.prompt_tokens_details?.cached_tokens ?? 0}`);
        return { message: cleanMessage(j.choices?.[0]?.message), provider: "groq", usage: j.usage };
      } catch (e) {
        errors.push(String(e?.message || e).slice(0, 160));
        console.warn(`llm groq ${model} →`, errors.at(-1));
      }
    }
  }
  if (!slowFallback) throw new Error(`sin modelo rápido disponible: ${errors.join(" | ")}`);
  try {
    const j = await env.AI.run(CF_MODEL, body);
    const m = j?.choices?.[0]?.message;
    if (!m) throw new Error("Workers AI sin respuesta");
    console.log(`[llm] workers-ai ${j.usage?.prompt_tokens} in / ${j.usage?.completion_tokens} out · ${Math.round(j.usage?.neurons || 0)} neuronas`);
    return { message: cleanMessage(m), provider: "workers-ai", usage: j.usage };
  } catch (e) {
    errors.push(String(e?.message || e));
  }
  const msg = `sin modelo disponible: ${errors.join(" | ")}`;
  throw errors.every((e) => isQuota(e)) ? new QuotaError(msg) : new Error(msg);
}
