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

const MAX_AUDIO_ITEMS = 8;

// Toma una transcripción de audio hablado (con saludos/muletillas/relleno) y
// extrae de ahí 1 o varias tareas/notas reales, ya limpias. Si falla o la
// respuesta no es un array usable, devuelve null (el caller cae al transcript
// completo como único item, nunca se pierde el audio ni el texto).
export async function classifyAudioTranscript(env, text) {
  if (!text || !text.trim()) return null;

  try {
    const now = new Date();
    const hoy = now.toISOString().slice(0, 10);
    const dia = DIAS[now.getUTCDay()];

    const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            `Eres un asistente que limpia transcripciones de notas de voz habladas de forma natural ` +
            `(con saludos, muletillas y relleno que hay que ignorar) y extrae de ahí las tareas o notas ` +
            `reales que el usuario quiere guardar. Hoy es ${dia}, ${hoy}.\n` +
            `El audio puede contener UNA o VARIAS cosas distintas a guardar (ej: "recuérdame llamar a Juan ` +
            `y también comprar leche mañana" son DOS items). Ignora saludos y frases de relleno tipo ` +
            `"esto es una prueba".\n` +
            `Responde SOLO con un array JSON, sin explicaciones, donde cada elemento tiene:\n` +
            `- "text": el contenido limpio y conciso de ESE item (sin relleno ni saludos), como si el ` +
            `usuario lo hubiera escrito directamente\n` +
            `- "kind": "tarea" (algo que hay que hacer), "nota" (información a recordar) o "material"\n` +
            `- "priority": "urgente", "normal", o "algun_dia"\n` +
            `- "category": contexto corto en minúsculas o null\n` +
            `- "due_date": fecha límite en formato YYYY-MM-DD si se menciona, o null\n` +
            `Ejemplo: [{"text":"Llamar a Juan","kind":"tarea","priority":"normal","category":null,"due_date":null},` +
            `{"text":"Comprar leche","kind":"tarea","priority":"normal","category":null,"due_date":"2026-07-13"}]\n` +
            `Si no hay nada accionable que extraer, devuelve un único item usando el texto completo tal cual.`,
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
      max_tokens: 500,
    });

    let out = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
    let arr;
    if (Array.isArray(out)) {
      arr = out;
    } else {
      const match = String(out || "").match(/\[[\s\S]*\]/);
      if (!match) return null;
      arr = JSON.parse(match[0]);
    }
    if (!Array.isArray(arr) || !arr.length) return null;

    const items = arr
      .map((j) => ({
        text: typeof j.text === "string" ? j.text.trim().slice(0, 500) : "",
        kind: ["tarea", "nota", "material"].includes(j.kind) ? j.kind : "tarea",
        priority: ["urgente", "normal", "algun_dia"].includes(j.priority) ? j.priority : "normal",
        category: typeof j.category === "string" && j.category ? j.category.slice(0, 40).toLowerCase() : null,
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(j.due_date || "") ? j.due_date : null,
      }))
      .filter((it) => it.text)
      .slice(0, MAX_AUDIO_ITEMS);

    return items.length ? items : null;
  } catch (e) {
    console.error("classifyAudioTranscript error:", e?.message || e);
    return null;
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
