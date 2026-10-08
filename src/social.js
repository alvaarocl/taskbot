// Asistente de X: avisa cuando hay algo que merece un post y prepara borradores. Nunca publica.
//
// Cada hora (cron :45) junta candidatos de todas las fuentes (blogs, Hacker News, GitHub Trending,
// Product Hunt) en un "pool" de 48 h y les da una temperatura: puntos de HN por hora, estrellas de hoy,
// lanzamiento oficial y, sobre todo, el mismo tema en varias fuentes a la vez (eso es que está pegando).
// La IA mira los más calientes y decide si alguno merece un post ahora; el código decide si avisar
// según la cadencia (`social.cadence`: un aviso cada 20–44 h, nada de noche, lo muy gordo se salta la espera).
// Noticias (fuentes con `news`): "Anthropic ha publicado…" en el momento, sin esperar a la cadencia; la IA
// descarta lo menor (clientes, alianzas). De noche se acumulan y llegan juntas a las 9.
// Eventos tech de Madrid: se miran una vez al día y solo se avisa de los nuevos que interesan.
//
// Telegram: /post idea, /radar (lo más caliente ahora), /cita N, /guardar N, /hilo.
// Botones: ✍️ borrador · ✅ publicado · ⏭ paso · ⭐ guardar · ➕ evento al calendario.
// Estado en KV (FILES) con prefijo `social:`. Fuentes y cadencia en config.js (`social`).

import config from "../config.js";
import { tg } from "./telegram.js";
import { nowMadrid, dayLabel, conflictsFor } from "./brain.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const UA = { "user-agent": "Mozilla/5.0 (compatible; taskbot; +https://github.com/alvaarocl/taskbot)" };
const DAY = 86400;
const HOUR = 3600e3;
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
    const date = Date.parse(decode(tag("pubDate") || tag("published") || tag("updated") || tag("dc:date") || "")) || null;
    return { title: decode(tag("title") || ""), url, summary: summary.slice(0, 280), date };
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
    out.push({ title: slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), url, summary: "" });
  }
  return out;
}

// "2026-10-08T16:00:00Z" → "2026-10-08T18:00" (hora de Madrid)
export function madridLocal(iso) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso)).replace(" ", "T");
}

const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const send = (env, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 4000), ...extra });
const noPreview = { link_preview_options: { is_disabled: true } };

// Lo que sale en un aviso se guarda con un número para los botones durante 3 semanas.
async function remember(env, item) {
  const n = Number((await env.FILES.get("social:n")) || 0) + 1;
  await env.FILES.put("social:n", String(n));
  await env.FILES.put(`social:item:${n}`, JSON.stringify(item), { expirationTtl: 21 * DAY });
  return n;
}
const recall = async (env, n) => env.FILES.get(`social:item:${n}`, { type: "json" });
const kvJson = async (env, key, fallback) => (await env.FILES.get(key, { type: "json" })) ?? fallback;

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

// ---------- candidatos ----------

// Un candidato: { key, source, title, url, summary, heat, signals, first }.
// `signals` explica la temperatura y llega tal cual a la IA y al aviso.

async function fromFeeds() {
  const out = [];
  for (const src of cfg().feeds) {
    try {
      const body = await get(src.url);
      const items = (src.type === "links" ? parseLinks(body, src.url, src.pattern) : parseFeed(body)).slice(0, 10);
      for (const i of items) out.push({ ...i, source: src.name, official: !!src.news });
    } catch (e) {
      console.error("feed", src.name, e?.message || e);
    }
  }
  return out;
}

async function fromHackerNews() {
  const { hits } = await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40", "json");
  return hits.sort((a, b) => b.points - a.points).slice(0, 20).map((h) => ({
    source: "Hacker News", title: h.title, summary: "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hn: { points: h.points, comments: h.num_comments, ageH: (Date.now() / 1000 - h.created_at_i) / 3600, id: h.objectID },
  }));
}

async function fromGitHub(languages) {
  const out = [];
  for (const lang of languages) {
    try {
      const html = await get(`https://github.com/trending/${encodeURIComponent(lang)}?since=daily`);
      for (const row of html.split('<article class="Box-row">').slice(1)) {
        const repo = row.match(/<h2[\s\S]*?href="\/([^"]+)"/)?.[1];
        if (!repo || out.some((r) => r.title === repo)) continue;
        out.push({
          source: "GitHub", title: repo, url: `https://github.com/${repo}`,
          summary: decode(row.match(/<p class="[^"]*">([\s\S]*?)<\/p>/)?.[1] || ""),
          stars: Number((row.match(/([\d,]+) stars today/)?.[1] || "0").replace(/,/g, "")),
        });
      }
    } catch (e) {
      console.error("trending", lang, e?.message || e);
    }
  }
  return out;
}

async function fromProductHunt() {
  return parseFeed(await get("https://www.producthunt.com/feed")).slice(0, 10).map((i) => ({ ...i, source: "Product Hunt" }));
}

const STOP = new Set(("the and for with from that this your into about what how why new now are was has have will you its our " +
  "los las del una para con por que como más sobre").split(" "));

// Palabras que identifican el tema: "Claude Haiku 5.5" y "/news/claude-haiku-5-5" comparten {claude, haiku}.
export function topicWords(it) {
  const slug = it.url.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
  return new Set(`${it.title} ${slug.replace(/[-_]/g, " ")}`.toLowerCase().split(/[^a-z0-9áéíóúñ]+/)
    .filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w)));
}

const sameTopic = (a, b) => {
  if (a.url === b.url) return true;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w) && !/^\d+$/.test(w)) shared++;
  return shared >= 2;
};

// Temperatura de todo el pool. Los ecos (mismo tema en otras fuentes) salen de un índice por palabra:
// comparar todos con todos no cabe en los 10 ms de CPU de la capa gratuita.
export function scoreAll(list) {
  const index = new Map();
  for (const it of list) {
    it.words = topicWords(it);
    for (const w of it.words) if (!/^\d+$/.test(w)) (index.get(w) || index.set(w, []).get(w)).push(it);
  }
  for (const it of list) {
    const shared = new Map();
    for (const w of it.words) for (const o of index.get(w) || []) if (o !== it) shared.set(o, (shared.get(o) || 0) + 1);
    const echoes = [...shared].filter(([o, c]) => c >= 2 || o.url === it.url).map(([o]) => o.source);
    it.echoes = [...new Set(echoes)].filter((src) => src !== it.source);
    Object.assign(it, heat(it));
  }
  for (const it of list) delete it.words;
  return list;
}

// Temperatura: 0 = nada, ~100 = lo que todo el mundo está comentando.
export function heat(it) {
  let h = 0;
  const signals = [];
  if (it.hn) {
    h += Math.min(60, it.hn.points / (it.hn.ageH + 2));
    signals.push(`HN ${it.hn.points} pts en ${Math.round(it.hn.ageH)} h`);
  }
  if (it.stars) {
    h += Math.min(50, it.stars / 150);
    signals.push(`+${it.stars.toLocaleString("es-ES")}★ hoy en GitHub`);
  }
  const ageH = (Date.now() - it.first) / HOUR;
  if (it.official && ageH < 12) {
    h += 35;
    signals.push(`publicado por ${it.source} hace ${Math.max(1, Math.round(ageH))} h`);
  } else if (!it.hn && !it.stars) h += 5;
  const echoes = it.echoes || [];
  if (echoes.length) {
    h += 25 * Math.min(3, echoes.length);
    signals.push(`también en ${echoes.join(", ")}`);
  }
  return { heat: Math.round(h), signals };
}

// Junta todo en el pool (48 h). La 1ª vez de cada fuente marca lo que ya había como antiguo.
async function refreshPool(env, hour) {
  const pool = await kvJson(env, "social:pool", {});
  const known = await kvJson(env, "social:known", {}); // fuentes ya leídas alguna vez
  const seen = new Set(await kvJson(env, "social:seenurls", [])); // URLs que ya pasaron por el pool
  const batches = [
    ["feeds", fromFeeds], ["hn", fromHackerNews], ["ph", fromProductHunt],
    // GitHub Trending por lenguajes cuando el cron no tiene otro trabajo (cuidando las 50 peticiones).
    ["gh", () => fromGitHub(hour % 3 === 2 ? cfg().github.languages : [""])],
  ];
  const now = Date.now();
  for (const [name, fn] of batches) {
    let items = [];
    try {
      items = await fn();
    } catch (e) {
      console.error("pool", name, e?.message || e);
      continue;
    }
    for (const it of items) {
      const key = it.url;
      const old = pool[key];
      // Si el feed trae fecha, manda. Si no: lo que ya estaba la primera vez que se lee una fuente,
      // o lo que salió del pool, cuenta como antiguo.
      const isOld = !known[it.source] || (!old && seen.has(key));
      const first = old?.first ?? (it.date ? Math.min(it.date, now) : isOld ? now - 3 * DAY * 1000 : now);
      pool[key] = { ...old, ...it, key, first };
      seen.add(key);
    }
    for (const s of new Set(items.map((i) => i.source))) known[s] = true;
  }
  // Fuera lo de más de 48 h, salvo lo que sigue en portada de HN o en Trending.
  for (const [k, it] of Object.entries(pool)) {
    const stale = now - it.first > 2 * DAY * 1000 && !(it.hn && it.hn.ageH < 24) && !it.stars;
    if (stale) delete pool[k];
  }
  const list = scoreAll(Object.values(pool));
  await env.FILES.put("social:pool", JSON.stringify(pool), { expirationTtl: 3 * DAY });
  await env.FILES.put("social:known", JSON.stringify(known));
  await env.FILES.put("social:seenurls", JSON.stringify([...seen].slice(-1500)));
  return list;
}

// Lo más caliente sin repetir tema ni lo ya avisado.
async function hottest(env, list, n) {
  const used = new Set(await kvJson(env, "social:used", []));
  const announced = await kvJson(env, "social:announced", {});
  const out = [];
  for (const it of [...list].sort((a, b) => b.heat - a.heat)) {
    if (out.length >= n) break;
    if (used.has(it.key) || it.first < Date.now() - 2 * DAY * 1000 && !it.hn && !it.stars) continue;
    if (Date.now() - (announced[it.key] || 0) < 3 * HOUR) continue; // acaba de llegar como noticia
    it.words = topicWords(it);
    if (out.some((o) => sameTopic(o, it))) continue;
    out.push(it);
  }
  for (const it of out) delete it.words;
  return out;
}

// ---------- decidir si avisar ----------

async function maybeSuggest(env, list, now) {
  const c = cfg().cadence;
  const hour = Number(now.time.slice(0, 2));
  if (hour >= c.quiet[0] || hour < c.quiet[1]) return; // de noche no

  const state = await kvJson(env, "social:cadence", { last: 0, day: null, count: 0 });
  if (state.day !== now.date) Object.assign(state, { day: now.date, count: 0 });
  const since = (Date.now() - state.last) / HOUR;
  if (state.count >= c.maxPerDay) return;

  const top = await hottest(env, list, 12);
  if (!top.length) return;
  // Sin cambios en lo más caliente desde la última vez: no hace falta volver a preguntar a la IA.
  const sig = top.map((t) => `${t.key}:${Math.round(t.heat / 10)}`).join("|");
  if (sig === state.sig && since < c.maxHours) return;
  state.sig = sig;

  const listing = top.map((t, i) =>
    `${i + 1}. [${t.source}] ${t.title}${t.summary ? ` — ${short(t.summary, 140)}` : ""} (temperatura ${t.heat}; ${t.signals.join("; ") || "sin señales"})`).join("\n");
  let j;
  try {
    j = await aiJson(env,
      `Ayudas a ${cfg().voice} a decidir si hay algo sobre lo que merezca publicar en X AHORA. ` +
      "Merece la pena: lanzamientos importantes de IA o herramientas de desarrollo, cosas que se están comentando mucho " +
      "(temperatura alta, varias fuentes a la vez) y temas que encajan con lo suyo (IA, agentes, Rust, apps nativas, startups, Madrid). " +
      "No merece la pena: notas corporativas menores (clientes, alianzas, casos de éxito), contenido genérico o repetido. " +
      'Responde SOLO con JSON: {"pick": número o null, "score": 0-10, "urgent": true si es algo gordo que no puede esperar a mañana, ' +
      '"why": "por qué ahora, una frase con las señales", "angle": "qué podría aportar él en su post, una frase"}',
      listing, 400);
  } catch (e) {
    console.error("juez", e?.message || e);
    await env.FILES.put("social:cadence", JSON.stringify(state));
    return;
  }
  const pick = top[Number(j.pick) - 1];
  const score = Number(j.score) || 0;
  const urgent = j.urgent === true || j.urgent === "true";
  const bar = since >= c.maxHours ? c.lateScore : since >= c.minHours ? c.minScore : urgent ? c.urgentScore : Infinity;
  await env.FILES.put("social:cadence", JSON.stringify(state));
  if (!pick || score < bar) return;

  const n = await remember(env, { ...pick, why: j.why, angle: j.angle });
  const used = await kvJson(env, "social:used", []);
  await env.FILES.put("social:used", JSON.stringify([...used, pick.key].slice(-200)), { expirationTtl: 7 * DAY });
  Object.assign(state, { last: Date.now(), count: state.count + 1 });
  await env.FILES.put("social:cadence", JSON.stringify(state));

  const head = urgent ? "🔥 Esto se está moviendo ahora" : "💡 Hay tema para post";
  await send(env,
    `${head}: ${pick.title}\n\n` +
    (j.why ? `Por qué ahora: ${j.why}\n` : "") +
    (pick.signals.length ? `Señales: ${pick.signals.join(" · ")}\n` : "") +
    (j.angle ? `Tu ángulo: ${j.angle}\n` : "") +
    `\n${pick.url}`, {
      reply_markup: { inline_keyboard: [
        [{ text: "✍️ Borrador", callback_data: `xd:${n}` }, { text: "⭐ Guardar", callback_data: `xs:${n}` }],
        [{ text: "✅ Publicado", callback_data: `xy:${n}` }, { text: "⏭ Paso", callback_data: `xn:${n}` }],
      ] },
    });
}

// ---------- noticias: lo que publican las fuentes con `news`, en el momento ----------

async function announceNews(env, list, now) {
  const [quietFrom, quietTo] = cfg().cadence.quiet;
  const hour = Number(now.time.slice(0, 2));
  if (hour >= quietFrom || hour < quietTo) return; // se quedan pendientes hasta la mañana

  const announced = await kvJson(env, "social:announced", {}); // url → cuándo se miró
  const pending = list
    .filter((it) => it.official && Date.now() - it.first < 18 * HOUR && !announced[it.key])
    .sort((a, b) => a.first - b.first)
    .slice(0, 12);
  if (!pending.length) return;

  const listing = pending.map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.summary ? ` — ${short(it.summary, 220)}` : ""}`).join("\n");
  let keep;
  try {
    const j = await aiJson(env,
      `Filtras novedades para ${cfg().voice} Avisa SOLO de lo que es noticia: un modelo, producto o función nuevos, ` +
      "una versión importante, un cambio de precio o de límites, una investigación relevante o algo que afecte a quien programa. " +
      "Descarta: casos de clientes, alianzas, contrataciones, eventos, encuestas, posts corporativos o de marketing y versiones menores con solo arreglos. " +
      'Responde SOLO con JSON: {"keep":[{"n": número, "line": "qué es y por qué importa, en español, una frase"}]}',
      listing, 600);
    keep = (Array.isArray(j.keep) ? j.keep : []).map((k) => ({ ...pending[Number(k.n) - 1], line: k.line })).filter((k) => k.key);
  } catch (e) {
    console.error("noticias", e?.message || e);
    return; // se reintenta en la próxima hora
  }
  for (const it of pending) announced[it.key] = Date.now();
  for (const [k, t] of Object.entries(announced)) if (Date.now() - t > 7 * DAY * 1000) delete announced[k];
  await env.FILES.put("social:announced", JSON.stringify(announced));
  if (!keep.length) return;

  const night = hour === quietTo && keep.some((it) => Date.now() - it.first > 3 * HOUR);
  if (keep.length <= 3 && !night) {
    for (const it of keep) {
      const n = await remember(env, { ...it, angle: null });
      await send(env, `🗞 ${it.source} ha publicado: ${it.title}${it.line ? `\n${it.line}` : ""}\n\n${it.url}`, {
        reply_markup: { inline_keyboard: [[
          { text: "✍️ Borrador", callback_data: `xd:${n}` },
          { text: "⭐ Guardar", callback_data: `xs:${n}` },
        ]] },
      });
    }
    return;
  }
  const lines = [];
  const buttons = [];
  for (const [i, it] of keep.slice(0, 8).entries()) {
    const n = await remember(env, { ...it, angle: null });
    lines.push(`${i + 1}. ${it.source}: ${short(it.title, 80)}${it.line ? `\n   ${it.line}` : ""}\n   ${it.url}`);
    buttons.push({ text: `✍️ ${i + 1}`, callback_data: `xd:${n}` });
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  await send(env, `🗞 ${night ? "Mientras dormías" : "Novedades"}\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: rows }, ...noPreview });
}

// ---------- eventos tech en Madrid (una vez al día, solo los nuevos) ----------

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
      where: e.geo_address_info?.address || e.geo_address_info?.city || "", host: o.calendar?.name || "",
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
      title: o.title, url: o.eventUrl, start, end: new Date(Date.parse(start) + 2 * HOUR).toISOString(),
      where: o.venue?.name === "Online event" ? "online" : o.venue?.name || "", host: o.group?.name || "",
    });
    return true;
  });
  return out;
}

export async function madridEvents(env) {
  const ev = cfg().events;
  const all = [];
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
  const seen = new Set(await kvJson(env, "social:events", []));
  const first = seen.size === 0;
  const now = Date.now();
  const candidates = [];
  for (const e of all) {
    const t = Date.parse(e.start);
    if (seen.has(e.url) || t < now || t > now + 21 * DAY * 1000) continue;
    seen.add(e.url);
    candidates.push(e);
  }
  await env.FILES.put("social:events", JSON.stringify([...seen].slice(-500)));
  if (!candidates.length) return;

  // La IA separa lo tech de lo demás (Luma Madrid mezcla catas, yoga y fiestas).
  let keep = [];
  try {
    const list = candidates.map((e, i) => `${i + 1}. ${e.title}${e.host ? ` · ${e.host}` : ""}${e.where === "online" ? " (online)" : ""}`).join("\n");
    const j = await aiJson(env,
      "Filtras eventos para un estudiante de Ingeniería Informática que ha cofundado un estudio de software en Madrid. " +
      "Interesan, y solo si son presenciales en Madrid: tecnología, programación, IA, datos, ciberseguridad, startups, emprendimiento, " +
      "producto, inversión, hackathons y comunidades tech. No interesan: ocio, deporte, idiomas, arte, bienestar, citas, fiestas, " +
      'cursos de pago ni eventos online. Responde SOLO con JSON: {"keep":[números de la lista que interesan]}',
      list, 300);
    if (Array.isArray(j.keep)) keep = j.keep.map((n) => candidates[Number(n) - 1]).filter(Boolean);
  } catch (e) {
    console.error("filtro eventos", e?.message || e);
    return;
  }
  if (first || !keep.length) return; // la primera vez solo se aprende lo que ya había
  const picked = keep.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5);
  const lines = [];
  const buttons = [];
  for (const [i, e] of picked.entries()) {
    const n = await remember(env, { ...e, source: "Evento" });
    const start = madridLocal(e.start);
    lines.push(`${i + 1}. ${dayLabel(start.slice(0, 10))} ${start.slice(11)} · ${short(e.title, 80)}${e.where ? `\n   📍 ${short(e.where, 60)}` : ""}\n   ${e.url}`);
    buttons.push({ text: `➕ ${i + 1}`, callback_data: `xe:${n}` });
  }
  await send(env,
    `📍 ${picked.length === 1 ? "Nuevo evento tech" : "Nuevos eventos tech"} en Madrid\n\n${lines.join("\n")}\n\n➕ lo añade a tu calendario; al acabar te pregunto si da para post.`,
    { reply_markup: { inline_keyboard: [buttons] }, ...noPreview });
}

// Eventos del calendario que acaban de terminar → "¿da para post?"
async function eventFollowups(env, now) {
  const to = `${now.date}T${now.time}`;
  const from = new Date(Date.parse(to + ":00Z") - 75 * 60e3).toISOString().slice(0, 16);
  const { results } = await env.DB.prepare(
    "SELECT id, text FROM items WHERE kind='evento' AND end_at > ? AND end_at <= ?"
  ).bind(from, to).all();
  for (const ev of results) {
    const k = `social:evt:${ev.id}`;
    if (await env.FILES.get(k)) continue;
    await env.FILES.put(k, "1", { expirationTtl: 7 * DAY });
    await send(env,
      `🎤 ¿Qué tal «${ev.text}»?\n\nSi da para post, mándame:\n/post lo que te llevas (una idea, alguien que conociste, un dato)\n\n` +
      "y te preparo dos versiones. Con una foto tuya del evento funciona mucho mejor; etiqueta a quien organiza.");
  }
}

export async function hourlySocial(env) {
  if (!cfg() || !env.OWNER_CHAT_ID) return;
  const now = nowMadrid();
  const hour = Number(now.time.slice(0, 2));
  const jobs = [
    ["pool", async () => {
      const list = await refreshPool(env, hour);
      await announceNews(env, list, now);
      await maybeSuggest(env, list, now);
    }],
    ["eventos", () => hour === cfg().events.hour && madridEvents(env)],
    ["fin de evento", () => eventFollowups(env, now)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (e) {
      console.error("social", name, e?.message || e);
    }
  }
}

// ---------- borradores y comandos ----------

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
  await tg(env, "sendMessage", { chat_id: chatId, text: header, ...noPreview });
  for (const [label, t] of [["A", j.a], ["B", j.b]]) {
    if (typeof t === "string" && t.trim()) await tg(env, "sendMessage", { chat_id: chatId, text: `${label} · ${t.trim().length} caracteres\n\n${t.trim()}` });
  }
}

async function quoteDrafts(env, chatId, item) {
  const context = `Fuente: ${item.source}\nTítulo: ${item.title}\n${item.summary ? `Resumen: ${item.summary}\n` : ""}` +
    `${item.signals?.length ? `Señales: ${item.signals.join("; ")}\n` : ""}${item.angle ? `Ángulo sugerido: ${item.angle}\n` : ""}Enlace: ${item.url}`;
  await sendDrafts(env, chatId,
    `✍️ ${item.title}\n🔗 ${item.url}\nSi hay post original en X, usa "Citar" con uno de estos; si no, publícalo con el enlace en la primera respuesta.`,
    context,
    "Vas a escribir el comentario que acompaña una cita (quote) o un post sobre esta noticia, repo o lanzamiento. No repitas el enlace ni la resumas entera; " +
    "aporta algo: una consecuencia, un contrapunto o para quién es útil. ");
}

// /post, /radar, /cita N, /guardar N, /hilo. Devuelve true si el mensaje era suyo.
export async function socialCommand(env, chatId, text) {
  if (!cfg()) return false;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const reply = (t, extra = {}) => tg(env, "sendMessage", { chat_id: chatId, text: t.slice(0, 4000), ...extra });

  if (cmd === "/post") {
    if (!arg) await reply("Dime de qué va: /post he ido al meetup de X, enseñaron Y y me quedo con Z");
    else await sendDrafts(env, chatId, "✍️ Dos versiones. Copia la que más te guste y retócala:", arg);
    return true;
  }
  if (cmd === "/radar") {
    const pool = Object.values(await kvJson(env, "social:pool", {}));
    const top = await hottest(env, pool, 10);
    if (!top.length) {
      await reply("Aún no hay nada en el radar (se llena cada hora).");
      return true;
    }
    const ids = [];
    const lines = [];
    for (const [i, t] of top.entries()) {
      ids.push(await remember(env, t));
      lines.push(`${i + 1}. 🌡${t.heat} ${short(t.title, 80)} · ${t.source}${t.signals.length ? `\n   ${t.signals.join(" · ")}` : ""}\n   ${t.url}`);
    }
    await env.FILES.put("social:radar", JSON.stringify(ids), { expirationTtl: 2 * DAY });
    await reply(`📡 Lo más caliente ahora\n\n${lines.join("\n")}\n\n✍️ /cita N → borrador · ⭐ /guardar N → para un hilo`, noPreview);
    return true;
  }
  if (cmd === "/cita" || cmd === "/guardar") {
    const ids = await kvJson(env, "social:radar", []);
    const n = ids[Number(arg) - 1];
    const item = n && await recall(env, n);
    if (!item) await reply(`Primero /radar y luego ${cmd} con el número de la lista, p. ej. ${cmd} 3.`);
    else if (cmd === "/cita") await quoteDrafts(env, chatId, item);
    else await reply(await save(env, n, item));
    return true;
  }
  if (cmd === "/hilo") {
    await threadDraft(env, chatId);
    return true;
  }
  return false;
}

async function save(env, n, item) {
  const ids = await kvJson(env, "social:saved", []);
  if (!ids.includes(n)) ids.push(n);
  await env.FILES.put("social:saved", JSON.stringify(ids.slice(-12)), { expirationTtl: 30 * DAY });
  return `⭐ Guardado (${ids.length}): ${short(item.title, 80)}. Con 3 o más, /hilo te escribe un hilo.`;
}

async function threadDraft(env, chatId) {
  const ids = await kvJson(env, "social:saved", []);
  const items = (await Promise.all(ids.map((n) => recall(env, n)))).filter(Boolean);
  if (items.length < 2) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Guarda al menos 2–3 cosas con ⭐ (en los avisos o con /guardar N desde /radar) y te escribo el hilo." });
    return;
  }
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  const list = items.map((i, k) => `${k + 1}. [${i.source}] ${i.title} — ${i.summary || ""} (${i.url})`).join("\n");
  let posts;
  try {
    const j = await aiJson(env, voiceRules() +
      "Escribe un hilo para X sobre lo más interesante que ha pasado últimamente en IA y desarrollo. " +
      "Primer post: gancho corto sin enlaces. Luego UN post por cada elemento de la lista, con una opinión breve y el enlace al final. " +
      "Último post: cierre preguntando qué se me ha escapado. Cada post de 270 caracteres como mucho. " +
      'Responde SOLO con JSON: {"posts":["…","…"]}', list, 1800);
    posts = Array.isArray(j.posts) ? j.posts.filter((t) => typeof t === "string" && t.trim()) : null;
  } catch (e) {
    console.error("hilo", e?.message || e);
  }
  if (!posts?.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ No he podido escribir el hilo. Lo guardado:\n\n${list}`.slice(0, 4000), ...noPreview });
    return;
  }
  await tg(env, "sendMessage", { chat_id: chatId, text: `🧵 Hilo (${posts.length} posts). Cópialos en orden y edita lo que no suene a ti.` });
  for (const [k, t] of posts.entries()) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `${k + 1}/${posts.length}\n${t.trim()}`, ...noPreview });
  }
  await env.FILES.delete("social:saved");
}

// Botones: xd (borrador), xs (guardar), xy (publicado), xn (paso), xe (evento al calendario).
export async function socialCallback(env, cb, action, n) {
  const chatId = cb.message.chat.id;
  const item = await recall(env, n);
  let notice = "";
  if (!item) notice = "Esto ya ha caducado";
  else if (action === "xd") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "✍️ Escribiendo…" });
    await quoteDrafts(env, chatId, item);
    return;
  } else if (action === "xs") {
    notice = "⭐ Guardado";
    await tg(env, "sendMessage", { chat_id: chatId, text: await save(env, n, item) });
  } else if (action === "xy" || action === "xn") {
    const { date } = nowMadrid();
    const s = await kvJson(env, "social:streak", { posts: 0, last: null });
    if (action === "xy") {
      s.posts += 1;
      s.last = date;
    }
    await env.FILES.put("social:streak", JSON.stringify(s));
    notice = action === "xy" ? `✅ Apuntado (${s.posts} posts desde que llevo la cuenta)` : "⏭ Vale, te aviso con lo siguiente";
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  } else if (action === "xe") {
    notice = await addEvent(env, chatId, item);
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: notice });
}

async function addEvent(env, chatId, e) {
  const start = madridLocal(e.start);
  const end = madridLocal(e.end || new Date(Date.parse(e.start) + 2 * HOUR).toISOString());
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
