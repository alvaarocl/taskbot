// Asistente de X: avisa de qué hay y de cuándo toca publicar, y prepara borradores.
// Nunca publica: solo busca, avisa y escribe borradores que se copian a mano.
//
// - Cada mañana (cron de las 8:00): radar (GitHub Trending, Hacker News, Product Hunt y lo nuevo de
//   las fuentes de lectura), el formato que toca hoy y, los lunes, eventos tech de Madrid.
// - Cada hora (cron :45): novedades de las fuentes con `alert` (OpenAI, Anthropic…) en el momento,
//   "¿post?" al acabar un evento del calendario, "¿has publicado hoy?" a las 21 y el hilo del viernes.
// - /post, /cita N y /guardar N desde Telegram; botones ✍️ ⭐ ➕ en los avisos.
//
// Estado en KV (FILES) con prefijo `social:`. Las fuentes y el plan semanal están en config.js (`social`).

import config from "../config.js";
import { tg } from "./telegram.js";
import { nowMadrid, addDays, dayLabel, conflictsFor } from "./brain.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const UA = { "user-agent": "Mozilla/5.0 (compatible; taskbot; +https://github.com/alvaarocl/taskbot)" };
const DAY = 86400;
const cfg = () => config.social;

// ---------- utilidades ----------

async function get(url, type = "text") {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return type === "json" ? r.json() : r.text();
}

export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const attr = (s, a) => s.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];

// RSS (<item>) y Atom (<entry>), sin dependencias.
export function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || [];
  return blocks.map((b) => {
    const tag = (n) => b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`))?.[1];
    const links = [...b.matchAll(/<link\b([^>]*?)\/?>/g)].map((m) => m[1]);
    const alt = links.find((l) => attr(l, "href") && (!attr(l, "rel") || attr(l, "rel") === "alternate"));
    const url = (alt ? attr(alt, "href") : decode(tag("link") || "")).replace(/&amp;/g, "&").trim();
    const summary = decode(tag("description") || tag("summary") || tag("content") || "");
    return { title: decode(tag("title") || ""), url, summary: summary.slice(0, 280) };
  }).filter((i) => i.title && /^https?:/.test(i.url));
}

// Páginas sin feed (Anthropic): enlaces que contienen `pattern`, en el orden de la página.
export function parseLinks(html, base, pattern) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/href="([^"#?]+)"/g)) {
    const path = m[1];
    if (!path.includes(pattern) || path.endsWith(pattern)) continue;
    const url = new URL(path, base).href;
    if (seen.has(url)) continue;
    seen.add(url);
    const slug = url.split("/").filter(Boolean).pop();
    const title = slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
    out.push({ title, url, summary: "" });
  }
  return out;
}

async function readSource(src) {
  const body = await get(src.url);
  return src.type === "links" ? parseLinks(body, src.url, src.pattern) : parseFeed(body);
}

// "2026-10-08T16:00:00Z" → "2026-10-08T18:00" (hora de Madrid)
export function madridLocal(iso) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso)).replace(" ", "T");
}

const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay(); // 0 = domingo
const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const send = (env, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 4000), ...extra });

// Cada cosa avisada se guarda con un número para los botones (✍️ ⭐ ➕) durante 3 semanas.
async function remember(env, item) {
  const n = Number((await env.FILES.get("social:n")) || 0) + 1;
  await env.FILES.put("social:n", String(n));
  await env.FILES.put(`social:item:${n}`, JSON.stringify(item), { expirationTtl: 21 * DAY });
  return n;
}
const recall = async (env, n) => env.FILES.get(`social:item:${n}`, { type: "json" });

// Para no repetir lo mismo en días seguidos.
async function fresh(env, key, ttlDays = 7) {
  const k = `social:seen1:${key}`;
  if (await env.FILES.get(k)) return false;
  await env.FILES.put(k, "1", { expirationTtl: ttlDays * DAY });
  return true;
}

async function aiJson(env, system, user, maxTokens = 700) {
  const res = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: maxTokens,
  });
  const out = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  if (out && typeof out === "object") return out;
  const m = String(out).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("la IA no devolvió JSON");
  return JSON.parse(m[0]);
}

// ---------- radar de la mañana ----------

async function githubTrending(env) {
  const all = [];
  for (const lang of cfg().github.languages) {
    try {
      const html = await get(`https://github.com/trending/${encodeURIComponent(lang)}?since=daily`);
      for (const row of html.split('<article class="Box-row">').slice(1)) {
        const repo = row.match(/<h2[\s\S]*?href="\/([^"]+)"/)?.[1];
        if (!repo || all.some((r) => r.repo === repo)) continue;
        all.push({
          repo,
          desc: decode(row.match(/<p class="[^"]*">([\s\S]*?)<\/p>/)?.[1] || ""),
          lang: decode(row.match(/itemprop="programmingLanguage">([^<]*)</)?.[1] || ""),
          today: Number((row.match(/([\d,]+) stars today/)?.[1] || "0").replace(/,/g, "")),
        });
      }
    } catch (e) {
      console.error("trending", lang, e?.message || e);
    }
  }
  all.sort((a, b) => b.today - a.today);
  const out = [];
  for (const r of all) {
    if (out.length >= cfg().github.top) break;
    if (await fresh(env, `gh:${r.repo}`)) out.push(r);
  }
  return out.map((r) => ({
    source: "GitHub", title: r.repo, url: `https://github.com/${r.repo}`, summary: r.desc,
    line: `${r.repo} · +${r.today.toLocaleString("es-ES")}★ hoy${r.lang ? ` · ${r.lang}` : ""}`,
  }));
}

async function hackerNews(env) {
  const { hits } = await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40", "json");
  const out = [];
  for (const h of hits.sort((a, b) => b.points - a.points)) {
    if (out.length >= cfg().hn.top || h.points < cfg().hn.minPoints) break;
    if (!(await fresh(env, `hn:${h.objectID}`, 3))) continue;
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    out.push({ source: "Hacker News", title: h.title, url, summary: "", line: `${h.title} (${h.points} pts)` });
  }
  return out;
}

async function productHunt(env) {
  const items = parseFeed(await get("https://www.producthunt.com/feed"));
  const out = [];
  for (const i of items) {
    if (out.length >= cfg().producthunt.top) break;
    if (await fresh(env, `ph:${i.url}`)) out.push({ ...i, source: "Product Hunt", line: i.title });
  }
  return out;
}

// Lo que llega cada hora de las fuentes de lectura se acumula aquí y sale en el radar.
async function takeReading(env, max = 6) {
  const buf = (await env.FILES.get("social:reading", { type: "json" })) || [];
  // Alternando fuentes para que no salgan 6 del mismo blog.
  const bySource = new Map();
  for (const i of buf) (bySource.get(i.source) || bySource.set(i.source, []).get(i.source)).push(i);
  const out = [];
  while (out.length < max && [...bySource.values()].some((l) => l.length)) {
    for (const l of bySource.values()) if (l.length && out.length < max) out.push(l.shift());
  }
  await env.FILES.delete("social:reading");
  return out.map((i) => ({ ...i, line: `${i.title} · ${i.source}` }));
}

function planLine(date) {
  const p = cfg().plan[weekday(date)];
  return p ? `Hoy toca: ${p}` : "Hoy no toca nada fijo: responde a 5–10 posts de cuentas grandes.";
}

export async function morningSocial(env) {
  if (!cfg() || !env.OWNER_CHAT_ID) return;
  const { date } = nowMadrid();
  const sections = [
    ["⭐ GitHub Trending", githubTrending],
    ["🔥 Hacker News", hackerNews],
    ["🚀 Product Hunt", productHunt],
    ["📰 Para leer", takeReading],
  ];
  const ids = [];
  const blocks = [];
  for (const [title, fn] of sections) {
    let items = [];
    try {
      items = await fn(env);
    } catch (e) {
      console.error("radar", title, e?.message || e);
    }
    if (!items.length) continue;
    const lines = [];
    for (const it of items) {
      ids.push(await remember(env, it));
      lines.push(`${ids.length}. ${short(it.line, 90)}${it.summary && it.source === "GitHub" ? `\n   ${short(it.summary, 110)}` : ""}\n   ${it.url}`);
    }
    blocks.push(`${title}\n${lines.join("\n")}`);
  }
  await env.FILES.put(`social:radar:${date}`, JSON.stringify(ids), { expirationTtl: 3 * DAY });

  const text = `📡 Radar · ${dayLabel(date)}\n${planLine(date)}\n\n` +
    (blocks.length ? blocks.join("\n\n") : "Hoy no hay nada nuevo en las fuentes.") +
    `\n\n✍️ /cita N → borrador para citarlo o comentarlo\n⭐ /guardar N → al hilo del viernes`;
  await send(env, text, { link_preview_options: { is_disabled: true } });
  await env.FILES.put(`social:radartext:${date}`, text, { expirationTtl: 2 * DAY });

  if (weekday(date) === 1) {
    try {
      await madridEvents(env);
    } catch (e) {
      console.error("eventos", e?.message || e);
    }
  }
}

// ---------- eventos tech en Madrid (lunes) ----------

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

function walk(o, visit) {
  if (Array.isArray(o)) o.forEach((v) => walk(v, visit));
  else if (o && typeof o === "object") {
    if (visit(o)) return;
    Object.values(o).forEach((v) => walk(v, visit));
  }
}

async function lumaEvents(city) {
  const out = [];
  walk(nextData(await get(`https://lu.ma/${city}`)), (o) => {
    if (!o.event?.start_at || !o.event?.url) return false;
    const e = o.event;
    out.push({
      title: e.name, url: `https://lu.ma/${e.url}`, start: e.start_at, end: e.end_at,
      where: e.geo_address_info?.address || e.geo_address_info?.city || "",
      host: o.calendar?.name || "",
    });
    return true;
  });
  return out;
}

async function meetupEvents(keyword) {
  const url = `https://www.meetup.com/find/?location=es--Madrid&source=EVENTS&keywords=${encodeURIComponent(keyword)}`;
  const out = [];
  walk(nextData(await get(url)), (o) => {
    if (o.__typename !== "Event" || !o.title || !o.dateTime || !o.eventUrl) return false;
    const start = new Date(o.dateTime).toISOString();
    out.push({
      title: o.title, url: o.eventUrl, start, end: new Date(Date.parse(start) + 2 * 3600e3).toISOString(),
      where: o.venue?.name === "Online event" ? "online" : o.venue?.name || "", host: o.group?.name || "",
    });
    return true;
  });
  return out;
}

export async function madridEvents(env) {
  const ev = cfg().events;
  let all = [];
  try {
    all.push(...(await lumaEvents(ev.luma)));
  } catch (e) {
    console.error("luma", e?.message || e);
  }
  for (const k of ev.meetupKeywords) {
    try {
      all.push(...(await meetupEvents(k)));
    } catch (e) {
      console.error("meetup", k, e?.message || e);
    }
  }
  const now = Date.now();
  const until = now + 14 * DAY * 1000;
  const urls = new Set();
  all = all.filter((e) => {
    const t = Date.parse(e.start);
    if (t < now || t > until || urls.has(e.url)) return false;
    urls.add(e.url);
    return true;
  });
  const candidates = [];
  for (const e of all) if (await fresh(env, `ev:${e.url}`, 30)) candidates.push(e);
  if (!candidates.length) return;

  // La IA separa lo tech de lo demás (Luma Madrid mezcla catas, yoga y fiestas).
  let keep = candidates.map((_, i) => i);
  try {
    const list = candidates.map((e, i) => `${i + 1}. ${e.title}${e.host ? ` · ${e.host}` : ""}`).join("\n");
    const j = await aiJson(env,
      "Filtras eventos para un estudiante de Ingeniería Informática que ha cofundado un estudio de software en Madrid. " +
      "Interesan: tecnología, programación, IA, datos, ciberseguridad, startups, emprendimiento, producto, diseño digital, " +
      "inversión, hackathons y comunidades tech. No interesan: ocio, deporte, idiomas, arte, bienestar, citas, fiestas ni clases de otras cosas. " +
      'Responde SOLO con JSON: {"keep":[números de la lista que interesan]}',
      list, 300);
    if (Array.isArray(j.keep)) keep = j.keep.map((n) => Number(n) - 1).filter((i) => candidates[i]);
  } catch (e) {
    console.error("filtro eventos", e?.message || e);
  }
  const picked = keep.map((i) => candidates[i]).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 10);
  if (!picked.length) return;

  const lines = [];
  const buttons = [];
  for (const [i, e] of picked.entries()) {
    const n = await remember(env, { ...e, source: "Evento" });
    const start = madridLocal(e.start);
    lines.push(`${i + 1}. ${dayLabel(start.slice(0, 10))} ${start.slice(11)} · ${short(e.title, 80)}${e.where ? `\n   📍 ${short(e.where, 60)}` : ""}\n   ${e.url}`);
    buttons.push({ text: `➕ ${i + 1}`, callback_data: `xe:${n}` });
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
  await send(env,
    `📍 Eventos tech en Madrid (próximas 2 semanas)\n\n${lines.join("\n")}\n\n➕ lo añade a tu calendario; al acabar te pregunto si da para post.`,
    { reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } });
}

// ---------- cada hora ----------

// Fuentes con `alert`: aviso en el momento. El resto se guarda para el radar de la mañana.
async function watchFeeds(env) {
  const reading = (await env.FILES.get("social:reading", { type: "json" })) || [];
  for (const src of cfg().feeds) {
    let items;
    try {
      items = (await readSource(src)).slice(0, 30); // las más recientes; hay feeds con cientos
    } catch (e) {
      console.error("feed", src.name, e?.message || e);
      continue;
    }
    const key = `social:feed:${src.name}`;
    const seen = await env.FILES.get(key, { type: "json" });
    const urls = items.map((i) => i.url);
    await env.FILES.put(key, JSON.stringify([...new Set([...urls, ...(seen || [])])].slice(0, 120)));
    if (!seen) continue; // primera vez: solo se aprende qué hay, sin avisar de todo lo antiguo
    const news = items.filter((i) => !seen.includes(i.url)).slice(0, 3);
    for (const it of news) {
      const item = { ...it, source: src.name };
      if (!src.alert) {
        reading.push(item);
        continue;
      }
      const n = await remember(env, item);
      await send(env, `🆕 ${src.name}: ${it.title}${it.summary ? `\n\n${short(it.summary, 240)}` : ""}\n\n${it.url}\n\nEn X suele salir a la vez: cítalo o responde con tu opinión.`, {
        reply_markup: { inline_keyboard: [[
          { text: "✍️ Borrador", callback_data: `xd:${n}` },
          { text: "⭐ Para el viernes", callback_data: `xs:${n}` },
        ]] },
      });
    }
  }
  await env.FILES.put("social:reading", JSON.stringify(reading.slice(-40)), { expirationTtl: 3 * DAY });
}

// Eventos del calendario que acaban de terminar → "¿da para post?"
async function eventFollowups(env, now) {
  const from = addMinutes(now, -75);
  const to = `${now.date}T${now.time}`;
  const { results } = await env.DB.prepare(
    "SELECT id, text, end_at FROM items WHERE kind='evento' AND end_at > ? AND end_at <= ?"
  ).bind(from, to).all();
  for (const ev of results) {
    if (!(await fresh(env, `evt:${ev.id}`, 7))) continue;
    await send(env,
      `🎤 ¿Qué tal «${ev.text}»?\n\nSi da para post, mándame:\n/post lo que te llevas (una idea, alguien que conociste, un dato)\n\n` +
      "y te preparo dos versiones. Con una foto tuya del evento funciona mucho mejor; etiqueta a quien organiza.");
  }
}

function addMinutes({ date, time }, min) {
  const t = Date.parse(`${date}T${time}:00Z`) + min * 60e3;
  return new Date(t).toISOString().slice(0, 16);
}

async function postedCheck(env, date) {
  if (!(await fresh(env, `asked:${date}`, 2))) return;
  await send(env, "🧭 ¿Has publicado hoy en X? (un post, un hilo o una cita; las respuestas cuentan si son buenas)", {
    reply_markup: { inline_keyboard: [[
      { text: "✅ Sí", callback_data: "xy:0" },
      { text: "😴 Hoy no", callback_data: "xn:0" },
    ]] },
  });
}

async function fridayThread(env, date) {
  if (!(await fresh(env, `thread:${date}`, 2))) return;
  const ids = (await env.FILES.get("social:saved", { type: "json" })) || [];
  const items = (await Promise.all(ids.map((n) => recall(env, n)))).filter(Boolean);
  if (items.length < 2) {
    await send(env, "🧵 Hoy toca el hilo de la semana, pero has guardado " +
      (items.length ? "solo una cosa" : "nada") + ". Mira el radar y guarda 3–5 con /guardar N o con ⭐ en los avisos.");
    return;
  }
  const list = items.map((i, k) => `${k + 1}. [${i.source}] ${i.title} — ${i.summary || ""} (${i.url})`).join("\n");
  let tweets;
  try {
    const j = await aiJson(env, voiceRules() +
      "Escribe un hilo para X: \"Lo que ha pasado esta semana en IA y desarrollo y merece la pena\". " +
      "Primer post: gancho corto sin enlaces. Luego UN post por cada elemento de la lista, con una opinión breve y el enlace al final. " +
      "Último post: cierre preguntando qué se me ha escapado. Cada post de 270 caracteres como mucho. " +
      'Responde SOLO con JSON: {"posts":["…","…"]}', list, 1800);
    tweets = Array.isArray(j.posts) ? j.posts.filter((t) => typeof t === "string" && t.trim()) : null;
  } catch (e) {
    console.error("hilo", e?.message || e);
  }
  if (!tweets?.length) {
    await send(env, `🧵 No he podido escribir el hilo. Esto es lo que guardaste:\n\n${list}`, { link_preview_options: { is_disabled: true } });
    return;
  }
  await send(env, `🧵 Borrador del hilo de la semana (${tweets.length} posts). Cópialos en orden; edita lo que no suene a ti.`);
  for (const [k, t] of tweets.entries()) {
    await send(env, `${k + 1}/${tweets.length}\n${t.trim()}`, { link_preview_options: { is_disabled: true } });
  }
  await env.FILES.delete("social:saved");
}

export async function hourlySocial(env) {
  if (!cfg() || !env.OWNER_CHAT_ID) return;
  const now = nowMadrid();
  const hour = Number(now.time.slice(0, 2));
  const jobs = [
    ["feeds", () => watchFeeds(env)],
    ["eventos", () => eventFollowups(env, now)],
    ["publicado", () => hour === cfg().checkHour && postedCheck(env, now.date)],
    ["hilo", () => hour === 9 && weekday(now.date) === 5 && fridayThread(env, now.date)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (e) {
      console.error("social", name, e?.message || e);
    }
  }
}

// ---------- borradores ----------

function voiceRules() {
  return `Escribes en nombre de ${cfg().voice} ` +
    "Reglas: español de España natural, en primera persona; frases cortas; una idea concreta y una opinión clara; " +
    "sin hashtags; como mucho un emoji; nada de frases de LinkedIn ni de vendedor (\"emocionado de anunciar\", \"game changer\", \"🚀\", \"hilo 🧵👇\"); " +
    "no inventes datos, cifras, nombres ni experiencias que no estén en el contexto. ";
}

async function sendDrafts(env, chatId, header, context, extra = "") {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  let j;
  try {
    j = await aiJson(env, voiceRules() + extra +
      "Escribe DOS versiones distintas de 270 caracteres como mucho: la A más directa e informativa, la B con más opinión o terminando en una pregunta. " +
      'Responde SOLO con JSON: {"a":"…","b":"…"}', context, 600);
  } catch (e) {
    console.error("borrador", e?.message || e);
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ No he podido escribir el borrador ahora. Prueba otra vez en un momento." });
    return;
  }
  await tg(env, "sendMessage", { chat_id: chatId, text: header, link_preview_options: { is_disabled: true } });
  for (const [label, t] of [["A", j.a], ["B", j.b]]) {
    if (typeof t === "string" && t.trim()) await tg(env, "sendMessage", { chat_id: chatId, text: `${label} · ${t.trim().length} caracteres\n\n${t.trim()}` });
  }
}

async function quoteDrafts(env, chatId, item) {
  const context = `Fuente: ${item.source}\nTítulo: ${item.title}\n${item.summary ? `Resumen: ${item.summary}\n` : ""}Enlace: ${item.url}`;
  await sendDrafts(env, chatId, `✍️ Para citar o comentar: ${item.title}\n🔗 ${item.url}\nAbre el post original en X y usa "Citar"; si no lo encuentras, publica el comentario con el enlace en la primera respuesta.`,
    context,
    "Vas a escribir el comentario que acompaña una cita (quote) de esta noticia, repo o lanzamiento. La cita ya enseña el enlace: no lo repitas ni la resumas entera; " +
    "aporta algo: una consecuencia, un contrapunto o para quién es útil. ");
}

// /post, /cita N, /guardar N, /radar. Devuelve true si el mensaje era suyo.
export async function socialCommand(env, chatId, text) {
  if (!cfg()) return false;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const { date } = nowMadrid();
  const todayItem = async (n) => {
    const ids = (await env.FILES.get(`social:radar:${date}`, { type: "json" })) || [];
    return ids[n - 1] ? { id: ids[n - 1], item: await recall(env, ids[n - 1]) } : null;
  };

  if (cmd === "/post") {
    if (!arg) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Dime de qué va: /post he ido al meetup de X, enseñaron Y y me quedo con Z" });
      return true;
    }
    await sendDrafts(env, chatId, "✍️ Dos versiones. Copia la que más te guste y retócala:", arg);
    return true;
  }
  if (cmd === "/cita" || cmd === "/guardar") {
    const found = await todayItem(Number(arg));
    if (!found?.item) {
      await tg(env, "sendMessage", { chat_id: chatId, text: `No encuentro el ${arg || "número"} en el radar de hoy. Usa el número de la lista, p. ej. ${cmd} 3.` });
      return true;
    }
    if (cmd === "/cita") await quoteDrafts(env, chatId, found.item);
    else await tg(env, "sendMessage", { chat_id: chatId, text: await save(env, found.id, found.item) });
    return true;
  }
  if (cmd === "/radar") {
    const t = await env.FILES.get(`social:radartext:${date}`);
    await tg(env, "sendMessage", { chat_id: chatId, text: t || "El radar de hoy aún no ha salido (llega con los buenos días).", link_preview_options: { is_disabled: true } });
    return true;
  }
  return false;
}

async function save(env, n, item) {
  const ids = (await env.FILES.get("social:saved", { type: "json" })) || [];
  if (!ids.includes(n)) ids.push(n);
  await env.FILES.put("social:saved", JSON.stringify(ids.slice(-12)), { expirationTtl: 14 * DAY });
  return `⭐ Guardado para el hilo del viernes (${ids.length}): ${short(item.title, 80)}`;
}

// Botones: xd (borrador de cita), xs (guardar), xe (evento al calendario), xy / xn (¿has publicado?).
export async function socialCallback(env, cb, action, n) {
  const chatId = cb.message.chat.id;
  let notice = "";
  if (action === "xy" || action === "xn") {
    const { date } = nowMadrid();
    const s = (await env.FILES.get("social:streak", { type: "json" })) || { n: 0, last: null };
    if (action === "xy" && s.last !== date) {
      s.n = s.last === addDays(date, -1) ? s.n + 1 : 1;
      s.last = date;
    } else if (action === "xn") {
      s.n = 0;
    }
    await env.FILES.put("social:streak", JSON.stringify(s));
    notice = action === "xy" ? `🔥 Racha: ${s.n} ${s.n === 1 ? "día" : "días"}` : "Mañana más. Racha a 0.";
    await tg(env, "editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: notice });
  } else {
    const item = await recall(env, n);
    if (!item) notice = "Esto ya ha caducado";
    else if (action === "xd") {
      notice = "✍️ Escribiendo…";
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
      await quoteDrafts(env, chatId, item);
      return;
    } else if (action === "xs") {
      notice = "⭐ Guardado";
      await tg(env, "sendMessage", { chat_id: chatId, text: await save(env, n, item) });
    } else if (action === "xe") {
      notice = await addEvent(env, chatId, item);
    }
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
}

async function addEvent(env, chatId, e) {
  const start = madridLocal(e.start);
  const end = madridLocal(e.end || new Date(Date.parse(e.start) + 2 * 3600e3).toISOString());
  const exists = await env.DB.prepare("SELECT id FROM items WHERE kind='evento' AND url=?").bind(e.url).first();
  if (exists) return "Ya estaba en tu calendario";
  const date = start.slice(0, 10);
  const minutes = Math.max(30, Math.round((Date.parse(end + ":00Z") - Date.parse(start + ":00Z")) / 60e3));
  const res = await env.DB.prepare(
    `INSERT INTO items (kind, text, category, priority, due_date, start_at, end_at, duration_min, location, url)
     VALUES ('evento', ?, 'evento', 'normal', ?, ?, ?, ?, ?, ?)`
  ).bind(e.title, date, start, end, minutes, e.where || null, e.url).run();
  const hits = await conflictsFor(env, date, start.slice(11), end.slice(11), res.meta.last_row_id);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `📅 Añadido: ${e.title}\n${dayLabel(date)} ${start.slice(11)}–${end.slice(11)}${e.where ? ` · ${e.where}` : ""}` +
      (hits.length ? `\n⚠️ Choca con: ${hits.map((h) => h.label).join(", ")}` : "") +
      "\nAl acabar te pregunto si da para post.",
  });
  return "📅 Añadido";
}
