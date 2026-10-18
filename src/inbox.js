// Bandeja del panel (pestaña Reuniones): mensajes de un formulario de contacto y reuniones reservadas en tu web.
// Opcional. Otro worker tuyo los empuja por service binding (host "internal", que solo existe dentro de Cloudflare):
//
//   POST https://internal/internal/inbox
//   { "id": "msg:<uuid>", "kind": "mensaje", "name": "…", "topic": "…", "message": "…" }
//   { "id": "book:<id>", "kind": "reunion", "name": "…", "topic": "…", "message": "…",
//     "start": "<ISO>", "end": "<ISO>", "duration": 30, "meet": "https://meet.google.com/…" }
//   { "id": "book:<id>", "status": "cancelada" }
//
// Sin email: solo lo que se ve en el panel. Se borra a los 90 días (mensajes desde que llegan; reuniones
// desde que terminan). Si lo usas con datos de otras personas, dilo en tu política de privacidad.

const KINDS = ["mensaje", "reunion"];
const STATUSES = ["nuevo", "visto", "cancelada"];
const KEEP_DAYS = 90;

const clip = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
const iso = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleInbox(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const b = await request.json().catch(() => null);
  const id = clip(b?.id, 200);
  if (!id) return json({ error: "invalid" }, 400);

  // Cancelación (la detecta el cron de avisos de api): solo cambia el estado.
  if (b.status === "cancelada" && !b.kind) {
    await env.DB.prepare("UPDATE inbox SET status='cancelada' WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (!KINDS.includes(b.kind)) return json({ error: "invalid" }, 400);

  if (b.kind === 'reunion' && (!iso(b.start) || !iso(b.end) || Date.parse(b.end) <= Date.parse(b.start))) return json({error:'invalid interval'},400);
  await env.DB.prepare(
    `INSERT INTO inbox (id, kind, name, topic, message, start_at, end_at, duration, meet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, topic=excluded.topic, message=excluded.message,
       start_at=excluded.start_at, end_at=excluded.end_at, duration=excluded.duration, meet=excluded.meet`
  ).bind(
    id, b.kind, clip(b.name, 80), clip(b.topic, 40), clip(b.message, 5000),
    iso(b.start), iso(b.end), Number.isFinite(+b.duration) ? +b.duration : null, clip(b.meet, 200),
  ).run();
  return json({ ok: true });
}

export async function listInbox(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM inbox ORDER BY COALESCE(start_at, created_at) DESC LIMIT 300"
  ).all();
  return results;
}

export async function markInbox(env, id, body) {
  if (!STATUSES.includes(body?.status) || body.status === "cancelada") return { error: "invalid" };
  await env.DB.prepare("UPDATE inbox SET status=? WHERE id=? AND status <> 'cancelada'").bind(body.status, id).run();
  return { ok: true };
}

export async function purgeInbox(env) {
  await env.DB.prepare(
    `DELETE FROM inbox WHERE
       (kind='mensaje' AND created_at < datetime('now', ?)) OR
       (kind='reunion' AND COALESCE(end_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`
  ).bind(`-${KEEP_DAYS} days`, `-${KEEP_DAYS} days`).run();
}
