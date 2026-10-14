// Resumen semanal del domingo (20:45 de Madrid, en el cron de :45; también con /resumen):
// tus commits y los de tus organizaciones (config.weekly), tareas cerradas, clases de la semana y un borrador
// de post "build in public". Se guarda en D1 (pestaña Semana del panel) y llega por Telegram. Nunca publica nada.
//
// GitHub: secreto GITHUB_TOKEN (fine-grained, solo lectura de contenido) para ver repos privados; sin él,
// solo lo público. Peticiones: 1 (mis commits) + por organización 1 + hasta maxRepos.

import config from "../config.js";
import { nowMadrid, addDays } from "./brain.js";
import { fixedAgenda } from "./overrides.js";
import { aiJson, voiceRules } from "./social.js";
import { tg } from "./telegram.js";

const cfg = () => config.weekly || {};
const GH = "https://api.github.com";

function ghHeaders(env) {
  const h = { accept: "application/vnd.github+json", "user-agent": "taskbot", "x-github-api-version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function gh(env, path) {
  const r = await fetch(GH + path, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`GitHub ${r.status} en ${path.split("?")[0]}`);
  return r.json();
}

// Semana ISO (YYYY-Www) de una fecha YYYY-MM-DD.
export function isoWeek(date) {
  const d = new Date(date + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const firstLine = (msg) => String(msg || "").split("\n")[0].slice(0, 120);

// Commits de la semana: los míos (búsqueda en todo GitHub) y los de cada organización (todo el equipo).
async function commits(env, sinceDate) {
  const since = `${sinceDate}T00:00:00Z`;
  const errors = [];
  const bySha = new Map();
  const add = (repo, sha, author, message, mine) => {
    if (!bySha.has(sha)) bySha.set(sha, { repo, author, message: firstLine(message), mine });
  };

  if (cfg().github) try {
    const q = encodeURIComponent(`author:${cfg().github} committer-date:>=${sinceDate}`);
    const j = await gh(env, `/search/commits?q=${q}&per_page=100&sort=committer-date`);
    for (const c of j.items || []) add(c.repository.full_name, c.sha, cfg().github, c.commit.message, true);
  } catch (e) { errors.push(String(e.message || e)); }

  for (const org of cfg().orgs || []) {
    try {
      const repos = await gh(env, `/orgs/${org}/repos?sort=pushed&direction=desc&per_page=30&type=all`);
      const active = repos.filter((r) => r.pushed_at >= since && !r.archived).slice(0, cfg().maxRepos || 6);
      for (const r of active) {
        const list = await gh(env, `/repos/${r.full_name}/commits?since=${since}&per_page=100`).catch((e) => { errors.push(String(e.message || e)); return []; });
        for (const c of list) {
          const login = c.author?.login || c.commit?.author?.name || "?";
          add(r.full_name, c.sha, login, c.commit.message, login.toLowerCase() === String(cfg().github || "").toLowerCase());
        }
      }
    } catch (e) { errors.push(String(e.message || e)); }
  }

  // Agrupado por repo: { repo, total, mine, authors: {login: n}, messages: [..] }
  const repos = new Map();
  for (const c of bySha.values()) {
    const r = repos.get(c.repo) || { repo: c.repo, total: 0, mine: 0, authors: {}, messages: [] };
    r.total++;
    if (c.mine) r.mine++;
    r.authors[c.author] = (r.authors[c.author] || 0) + 1;
    if (r.messages.length < 8) r.messages.push(c.message);
    repos.set(c.repo, r);
  }
  return { repos: [...repos.values()].sort((a, b) => b.total - a.total), errors };
}

async function closedTasks(env, from) {
  const { results } = await env.DB.prepare(
    `SELECT text, category, source FROM items WHERE status='hecha' AND done_at >= ? ORDER BY done_at`
  ).bind(`${from} 00:00:00`).all();
  return results.map((t) => ({ text: String(t.text || "").slice(0, 120), category: t.category, aula: /^ag:/.test(t.source || "") }));
}

async function classes(env, from, to) {
  const { sessions } = await fixedAgenda(env, from, to);
  const by = {};
  let minutes = 0;
  for (const s of sessions) {
    const m = (+s.end.slice(0, 2) * 60 + +s.end.slice(3)) - (+s.start.slice(0, 2) * 60 + +s.start.slice(3));
    minutes += m;
    by[s.subject] = (by[s.subject] || 0) + 1;
  }
  return { sessions: sessions.length, hours: Math.round(minutes / 6) / 10, bySubject: by };
}

async function draftPost(env, data) {
  const context = [
    `Semana ${data.week} (${data.from} → ${data.to}).`,
    data.commits.repos.length
      ? "Commits:\n" + data.commits.repos.map((r) => `- ${r.repo}: ${r.total} commits (${r.mine} míos). Mensajes: ${r.messages.join(" | ")}`).join("\n")
      : "Sin commits esta semana.",
    `Tareas cerradas: ${data.tasks.length}${data.tasks.length ? ` (${data.tasks.slice(0, 15).map((t) => t.text).join("; ")})` : ""}.`,
    `Clases: ${data.classes.sessions} sesiones, ${data.classes.hours} h.`,
  ].join("\n");
  try {
    const j = await aiJson(env, voiceRules() +
      "Escribe un post de 'build in public' para X que resuma la semana: qué he construido o avanzado y qué viene. " +
      "Concreto, con nombres de proyectos del contexto, sin listar commits uno a uno. 280 caracteres como mucho. " +
      "No menciones repos que suenen privados o internos si no aportan. " +
      'Responde SOLO con JSON: {"post":"…"}', context, 500);
    return typeof j.post === "string" ? j.post.trim() : null;
  } catch (e) {
    console.error("borrador semanal", e?.message || e);
    return null;
  }
}

/** Telegram: texto plano, como el resto del bot. */
export function weeklyText(data, draft) {
  const lines = [`📊 Tu semana · ${data.from.slice(5).split("-").reverse().join("/")} – ${data.to.slice(5).split("-").reverse().join("/")}`, ""];
  const total = data.commits.repos.reduce((n, r) => n + r.total, 0);
  const mine = data.commits.repos.reduce((n, r) => n + r.mine, 0);
  lines.push(`💻 ${total} commits (${mine} tuyos) en ${data.commits.repos.length} repos`);
  for (const r of data.commits.repos.slice(0, 8)) lines.push(`   • ${r.repo} · ${r.total}${r.mine !== r.total ? ` (${r.mine} tuyos)` : ""}`);
  lines.push(`✅ ${data.tasks.length} tareas cerradas${data.tasks.filter((t) => t.aula).length ? ` (${data.tasks.filter((t) => t.aula).length} de ${config.aulaGlobal?.name || "Moodle"})` : ""}`);
  lines.push(`📚 ${data.classes.sessions} clases · ${data.classes.hours} h`);
  if (data.commits.errors.length) lines.push(`\n⚠️ GitHub: ${data.commits.errors[0]}`);
  if (draft) lines.push("", "✍️ Borrador build in public (no publico nada):", "", draft);
  return lines.join("\n");
}

export async function buildWeekly(env, { send = true } = {}) {
  const { date } = nowMadrid();
  const from = addDays(date, -6);
  const week = isoWeek(date);
  const [c, tasks, cls] = await Promise.all([commits(env, from), closedTasks(env, from), classes(env, from, date)]);
  const data = { week, from, to: date, commits: c, tasks, classes: cls };
  const draft = await draftPost(env, data);
  await env.DB.prepare(
    `INSERT INTO weekly (week, data, draft) VALUES (?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET data=excluded.data, draft=excluded.draft, created_at=datetime('now')`
  ).bind(week, JSON.stringify(data), draft).run();
  const text = weeklyText(data, draft);
  if (send) await tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } });
  return { data, draft, text };
}

export async function listWeekly(env) {
  const { results } = await env.DB.prepare("SELECT week, data, draft, created_at FROM weekly ORDER BY week DESC LIMIT 26").all();
  return results.map((w) => ({ ...w, data: JSON.parse(w.data) }));
}
