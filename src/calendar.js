import { typeLabel } from "./sync.js";
import { fixedAgenda } from "./overrides.js";

// /calendar.ics (calendario "Taskbot"): eventos y bloques de tareas con su hora;
// las tareas con fecha límite pero aún sin bloque salen como día completo.
export async function handleCalendar(url, env) {
  if (url.searchParams.get("t") !== env.CAL_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, kind, text, priority, due_date, start_at, end_at, location, url FROM items
     WHERE status='pendiente' AND kind IN ('tarea','evento') AND (start_at IS NOT NULL OR due_date IS NOT NULL)
       AND NOT (start_at IS NULL AND (source LIKE 'ag:%' OR source LIKE 'crono:%'))
     ORDER BY COALESCE(start_at, due_date)`
  ).all();

  const events = results.map((it) => {
    const prefix = it.kind === "evento" ? "" : it.priority === "urgente" ? "🔥 " : it.priority === "algun_dia" ? "🌙 " : "🧠 ";
    const base = { uid: `item-${it.id}`, summary: prefix + it.text, location: it.location };
    if (it.start_at) {
      return {
        ...base,
        date: it.start_at.slice(0, 10), start: it.start_at.slice(11, 16), end: it.end_at.slice(11, 16),
        description: [it.kind === "tarea" && it.due_date ? `Fecha límite: ${it.due_date}` : null, it.url].filter(Boolean).join("\n") || null,
        alarmMin: it.kind === "evento" ? 15 : null,
      };
    }
    return { ...base, date: it.due_date, allDay: true, description: it.url };
  });

  return icsResponse(buildCalendar("Taskbot", events));
}

// /cal/clases.ics y /cal/rutina.ics: calendarios suscritos de solo lectura.
export async function handleScheduleFeed(url, env) {
  if (url.searchParams.get("t") !== env.CAL_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  // Apple pone un color por calendario, no por evento: exámenes y prácticas van aparte.
  let name, events, color;
  const path = url.pathname;
  if (path === "/cal/clases.ics" || path === "/cal/practicas.ics") {
    const practicas = path === "/cal/practicas.ics";
    const { sessions } = await fixedAgenda(env);
    name = practicas ? "UC3M · Prácticas" : "UC3M · Clases";
    color = practicas ? "#FF9500" : null;
    events = sessions.filter((s) => (s.type === "PRÁCTICAS") === practicas).map((s) => ({
      uid: `uc3m-${s.key.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "-")}`,
      date: s.date, start: s.start, end: s.end,
      summary: (s.type === "RECUPERACIÓN" ? "⚠️ " : "") + `${s.subject} · ${typeLabel(s.type)}`,
      location: s.room === "Virtual" ? "Virtual" : `Aula ${s.room} · UC3M Leganés`,
    }));
    if (practicas) events.push(...(await deadlineEvents(env)));
  } else if (path === "/cal/examenes.ics") {
    name = "UC3M · Exámenes";
    color = "#FF3B30";
    events = (await fixedAgenda(env)).examEvents;
  } else if (path === "/cal/rutina.ics") {
    name = "Rutina";
    events = (await fixedAgenda(env)).routine;
  } else {
    return new Response("not found", { status: 404 });
  }
  return icsResponse(buildCalendar(name, events, color));
}

// Entregas y cuestionarios (Aula Global y cronogramas): a la hora exacta en que cierran.
// Sin hora conocida, día completo.
async function deadlineEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, text, due_date, due_at, url FROM items
     WHERE status='pendiente' AND (source LIKE 'ag:%' OR source LIKE 'crono:%') AND due_date IS NOT NULL`
  ).all();
  return results.map((it) => {
    const base = { uid: `deadline-${it.id}`, summary: `⏰ ${it.text.replace(/^Entregar: /, "Entrega: ")}`, description: it.url };
    if (!it.due_at) return { ...base, date: it.due_date, allDay: true };
    const end = it.due_at.slice(11, 16);
    return { ...base, date: it.due_at.slice(0, 10), start: end, end, alarmMin: 24 * 60 };
  });
}

export function buildCalendar(name, events, color = null) {
  const stamp = toUtcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//taskbot//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    // Color con el que Apple crea el calendario al suscribirse (luego se puede cambiar).
    ...(color ? [`X-APPLE-CALENDAR-COLOR:${color}`] : []),
    "X-WR-TIMEZONE:Europe/Madrid",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...MADRID_TZ,
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@taskbot.YOUR-SUBDOMAIN.workers.dev`,
      `DTSTAMP:${stamp}`,
      ...(e.allDay
        ? [`DTSTART;VALUE=DATE:${e.date.replaceAll("-", "")}`]
        : [`DTSTART;TZID=Europe/Madrid:${local(e.date, e.start)}`, `DTEND;TZID=Europe/Madrid:${local(e.date, e.end)}`]),
      `SUMMARY:${escapeText(e.summary)}`
    );
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.tentative) lines.push("STATUS:TENTATIVE");
    if (e.alarmMin) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.summary)}`,
        `TRIGGER:-PT${e.alarmMin}M`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function icsResponse(body) {
  return new Response(body, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-cache" },
  });
}

const local = (date, time) => `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;

// RFC 5545: líneas de máx. 75 octetos; las siguientes empiezan por un espacio.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "", size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; size = 0; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const MADRID_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Madrid",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function toUtcStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
