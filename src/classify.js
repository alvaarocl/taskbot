// Clasificación con Workers AI (gratis). Si falla o no hay respuesta válida,
// el item cae como tarea normal sin categoría — nunca se pierde nada.

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export async function classify(env, text) {
  const fallback = { kind: "tarea", priority: "normal", category: null, due_date: null };
  if (!text || !text.trim()) return { ...fallback, kind: "material" };

  try {
    const now = new Date();
    const hoy = now.toISOString().slice(0, 10);
    const dia = DIAS[now.getUTCDay()];

    // Si este modelo se depreca, ver alternativas con: npx wrangler ai models
    const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            `Eres un clasificador de notas personales. Hoy es ${dia}, ${hoy}. ` +
            `Analiza el mensaje del usuario y responde SOLO con un JSON válido, sin explicaciones, con estas claves:\n` +
            `- "kind": "tarea" (algo que hay que hacer), "nota" (información a recordar) o "material" (recurso para usar después)\n` +
            `- "priority": "urgente" (explícitamente urgente o con plazo inminente), "normal", o "algun_dia" (algún día / cuando pueda / sin prisa)\n` +
            `- "category": contexto corto en minúsculas (ej: "cliente", "empresa", "personal", un nombre propio) o null si no está claro\n` +
            `- "due_date": fecha límite en formato YYYY-MM-DD si el mensaje menciona una ("mañana", "el viernes", "antes del 15"), o null\n` +
            `Ejemplo: {"kind":"tarea","priority":"normal","category":"cliente","due_date":"2026-07-10"}`,
        },
        { role: "user", content: text.slice(0, 1000) },
      ],
      max_tokens: 150,
    });

    // Según el modelo, la respuesta puede venir como string, objeto ya parseado
    // o en formato OpenAI (choices[0].message.content)
    let out = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
    let j;
    if (out && typeof out === "object") {
      j = out;
    } else {
      const match = String(out || "").match(/\{[\s\S]*?\}/);
      if (!match) return fallback;
      j = JSON.parse(match[0]);
    }

    return {
      kind: ["tarea", "nota", "material"].includes(j.kind) ? j.kind : "tarea",
      priority: ["urgente", "normal", "algun_dia"].includes(j.priority) ? j.priority : "normal",
      category: typeof j.category === "string" && j.category ? j.category.slice(0, 40).toLowerCase() : null,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(j.due_date || "") ? j.due_date : null,
    };
  } catch (e) {
    console.error("classify error:", e?.message || e);
    return fallback;
  }
}

export async function transcribe(env, arrayBuffer) {
  try {
    // Convert to base64 in 32 KB chunks — a single spread over large buffers blows the call stack
    const bytes = new Uint8Array(arrayBuffer);
    const CHUNK = 32 * 1024;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);

    const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: base64 });

    // Shape may vary across model versions — extract defensively
    const text = res?.text ?? res?.response ?? res?.choices?.[0]?.message?.content ?? null;
    if (typeof text !== "string" || !text.trim()) return null;
    return text.trim();
  } catch (e) {
    console.error("transcribe error:", e?.message || e);
    return null;
  }
}
