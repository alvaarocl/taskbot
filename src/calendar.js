export async function handleCalendar(url, env) {
  if (url.searchParams.get("t") !== env.CAL_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }

  const { results } = await env.DB.prepare(
    "SELECT id, text, priority, due_date FROM items WHERE kind='tarea' AND status='pendiente' AND due_date IS NOT NULL ORDER BY due_date"
  ).all();

  const stamp = toUtcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//taskbot//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Taskbot",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const it of results) {
    const prefix = it.priority === "urgente" ? "🔥 " : it.priority === "algun_dia" ? "🌙 " : "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:item-${it.id}@taskbot.alvarocarpintero2.workers.dev`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${it.due_date.replaceAll("-", "")}`,
      `SUMMARY:${escapeText(prefix + it.text)}`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function toUtcStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
