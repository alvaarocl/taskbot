import { classify } from "./classify.js";

const EDITABLE = ["kind", "status", "text", "category", "priority", "due_date"];

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "") || url.searchParams.get("t");
  if (token !== env.DASH_TOKEN) return json({ error: "unauthorized" }, 401);

  const parts = url.pathname.split("/").filter(Boolean); // ["api", "items", id?]
  if (parts[1] !== "items") return json({ error: "not found" }, 404);
  const id = parts[2] ? Number(parts[2]) : null;

  try {
    if (request.method === "GET" && !id) return listItems(url, env);
    if (request.method === "POST" && !id) return createItem(request, env);
    if (request.method === "PATCH" && id) return patchItem(request, env, id);
    if (request.method === "DELETE" && id) return deleteItem(env, id);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: "not found" }, 404);
}

async function listItems(url, env) {
  const status = url.searchParams.get("status");
  const kind = url.searchParams.get("kind");
  let sql = "SELECT * FROM items WHERE 1=1";
  const binds = [];
  if (status) { sql += " AND status=?"; binds.push(status); }
  if (kind) { sql += " AND kind=?"; binds.push(kind); }
  sql += " ORDER BY CASE priority WHEN 'urgente' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due_date IS NULL, due_date, id DESC";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  if (results.length) {
    const ids = results.map((i) => i.id);
    const ph = ids.map(() => "?").join(",");
    const atts = await env.DB.prepare(`SELECT * FROM attachments WHERE item_id IN (${ph})`).bind(...ids).all();
    const byItem = {};
    for (const a of atts.results) (byItem[a.item_id] ||= []).push(a);
    for (const i of results) i.attachments = byItem[i.id] || [];
  }
  return json({ items: results });
}

async function createItem(request, env) {
  const body = await request.json();
  const text = (body.text || "").trim();
  if (!text) return json({ error: "text required" }, 400);

  // Si el dashboard no especifica clasificación, la hace la IA
  const cls = body.kind ? {
    kind: body.kind,
    priority: body.priority || "normal",
    category: body.category || null,
    due_date: body.due_date || null,
  } : await classify(env, text);

  const res = await env.DB.prepare(
    "INSERT INTO items (kind, text, category, priority, due_date) VALUES (?, ?, ?, ?, ?)"
  ).bind(cls.kind, text, cls.category, cls.priority, cls.due_date).run();

  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(res.meta.last_row_id).first();
  item.attachments = [];
  return json({ item }, 201);
}

async function patchItem(request, env, id) {
  const body = await request.json();
  const sets = [];
  const binds = [];
  for (const f of EDITABLE) {
    if (f in body) {
      sets.push(`${f}=?`);
      binds.push(body[f] === "" ? null : body[f]);
    }
  }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
  if (body.status === "hecha") sets.push("done_at=datetime('now')");
  if (body.status === "pendiente") sets.push("done_at=NULL");
  binds.push(id);
  await env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(id).first();
  return json({ item });
}

async function deleteItem(env, id) {
  const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE item_id=?").bind(id).all();
  for (const a of atts.results) await env.FILES.delete(a.r2_key);
  await env.DB.prepare("DELETE FROM attachments WHERE item_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
