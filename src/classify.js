// Clasificación con Workers AI (gratis). Si falla o no hay respuesta válida,
// el item cae como tarea normal sin categoría — nunca se pierde nada.

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const KINDS = ["tarea", "evento", "examen", "cancelacion", "nota", "material"];

// Fecha de hoy en Madrid (en UTC, de 00:00 a 02:00 sería todavía ayer).
function hoyMadrid() {
  const hoy = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  return { hoy, dia: DIAS[new Date(hoy + "T12:00:00Z").getUTCDay()] };
}

const FIELDS =
  `- "title": título corto y limpio para el calendario, sin la fecha ni la hora (ej: "Reunión con Marco", "Práctica 1 de Sistemas Operativos", ` +
  `en un examen "Parcial de Cálculo" o "Final de Sistemas Operativos")\n` +
  `- "kind": "cancelacion" (dice que algo de su horario fijo NO va a pasar un día: "este sábado no hay partido", ` +
  `"el jueves no hay entreno", "no hay clase de IA el martes"; en "title" pon SOLO lo que se cancela: "partido", "entreno" o "clase de IA"), ` +
  `"examen" (examen, parcial, final, prueba o test de una asignatura, con fecha), ` +
  `"evento" (algo con fecha Y hora concretas: reunión, cita, quedada, llamada a una hora), ` +
  `"tarea" (algo que hay que hacer, aunque tenga fecha límite), "nota" (información a recordar) o "material" (recurso para usar después)\n` +
  `- "priority": "urgente" (explícitamente urgente o con plazo inminente), "normal", o "algun_dia" (algún día / cuando pueda / sin prisa)\n` +
  `- "category": contexto corto en minúsculas (ej: "uni", "laaabs", "baloncesto", "personal", un nombre propio) o null\n` +
  `- "due_date": YYYY-MM-DD. En una tarea, la fecha límite ("mañana", "el viernes", "antes del 15"); en un evento, el día en que es. O null\n` +
  `- "time": hora de inicio "HH:MM" en 24 h si es un evento o un examen y se dice, o null\n` +
  `- "duration_min": minutos. En un evento, lo que dura (si no se dice: 60); en un examen, lo que dura (si no se dice: 90). En una tarea, tu estimación realista de lo que se tarda en hacerla (15 a 240)\n` +
  `- "location": sitio del evento si se menciona, o null\n`;

function normalize(j) {
  const kind = KINDS.includes(j.kind) ? j.kind : "tarea";
  const due = /^\d{4}-\d{2}-\d{2}$/.test(j.due_date || "") ? j.due_date : null;
  const time = /^\d{2}:\d{2}$/.test(j.time || "") ? j.time : null;
  const dur = Math.round(Number(j.duration_min));
  return {
    title: typeof j.title === "string" && j.title.trim() ? j.title.trim().slice(0, 120) : null,
    // Un "evento" sin día u hora no se puede poner en el calendario: se guarda como tarea.
    // Un examen sin fecha tampoco: se guarda como tarea.
    kind: (kind === "evento" && !(due && time)) || (kind === "examen" && !due) ? "tarea"
      : kind === "cancelacion" && !due ? "nota" : kind,
    priority: ["urgente", "normal", "algun_dia"].includes(j.priority) ? j.priority : "normal",
    category: typeof j.category === "string" && j.category ? j.category.slice(0, 40).toLowerCase() : null,
    due_date: due,
    time,
    duration_min: Number.isFinite(dur) && dur >= 5 ? Math.min(dur, 600) : null,
    location: typeof j.location === "string" && j.location ? j.location.slice(0, 80) : null,
  };
}

export async function classify(env, text) {
  const fallback = { kind: "tarea", priority: "normal", category: null, due_date: null, time: null, duration_min: null, location: null };
  if (!text || !text.trim()) return { ...fallback, kind: "material" };

  try {
    const { hoy, dia } = hoyMadrid();

    // Si este modelo se depreca, ver alternativas con: npx wrangler ai models
    const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            `Eres un clasificador de notas personales. Hoy es ${dia}, ${hoy}. ` +
            `Analiza el mensaje del usuario y responde SOLO con un JSON válido, sin explicaciones, con estas claves:\n` +
            FIELDS +
            `Ejemplos: {"title":"Reunión de laaabs","kind":"evento","priority":"normal","category":"laaabs","due_date":"2026-10-08","time":"17:00","duration_min":60,"location":null}\n` +
            `{"title":"Práctica 2 de Estructura de Datos","kind":"tarea","priority":"normal","category":"uni","due_date":"2026-10-09","time":null,"duration_min":120,"location":null}`,
        },
        { role: "user", content: text.slice(0, 1000) },
      ],
      max_tokens: 200,
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

    return normalize(j);
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
    const { hoy, dia } = hoyMadrid();

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
            FIELDS +
            `Ejemplo: [{"text":"Llamar a Juan","kind":"tarea","priority":"normal","category":null,"due_date":null},` +
            `{"text":"Comprar leche","kind":"tarea","priority":"normal","category":null,"due_date":"2026-07-13"}]\n` +
            `Si no hay nada accionable que extraer, devuelve un único item usando el texto completo tal cual.`,
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
      max_tokens: 700,
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
        ...normalize(j),
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
