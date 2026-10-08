// Horario de la UC3M leído de la web pública (aplicaciones.uc3m.es/horarios-web).
// "Mi horario" de la app solo exporta un .ics descargable; esta web sale del mismo sistema
// y trae cada sesión con su fecha y aula, así que se puede leer sin login.

import config from "../config.js";

const BASE = "https://aplicaciones.uc3m.es/horarios-web/publicacion";

const MONTHS = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };

// Matrícula: `uc3m` en config.js.
export const UC3M_CONFIG = config.uc3m;

export function pageUrl(cfg, p) {
  return `${BASE}/${cfg.year}/porCentroPlanCursoGrupo.tt?plan=${cfg.plan}&centro=${cfg.centro}` +
    `&curso=${p.curso}&grupo=${p.grupo}&tipoPer=C&valorPer=${p.per}&tipoAsig=OPT`;
}

// Devuelve una sesión por cada fecha concreta:
// { key, code, subject, group, type, date: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM", room }
export function parseTimetable(html, year) {
  const sessions = [];
  const cells = html.split('class="celdaConSesion').slice(1);
  for (const raw of cells) {
    const cell = raw.split("</td>")[0];
    const type = text(match(cell, /border: 1px dotted black">([^<]+)</));
    const head = text(match(cell, /class="asignaturaAgrupacion">([\s\S]*?)<\/div>/));
    const hm = /(\d{2}:\d{2}) a (\d{2}:\d{2})/.exec(cell);
    if (!head || !hm) continue;
    const hd = /^(\d+)-(.+?), .*grp\.(\d+)/.exec(head);
    if (!hd) continue;
    const [, code, subject, group] = hd;

    const re = /class="fechas">([^<]+):<\/span><span class="aulas">([^<]*)</g;
    let m;
    while ((m = re.exec(cell))) {
      const room = text(m[2]).replace(/^Aula\s+/i, "");
      for (const date of expandDates(m[1].trim(), year)) {
        sessions.push({
          key: `${code}|${group}|${type}|${date}|${hm[1]}`,
          code, subject: titleCase(subject), group, type,
          date, start: hm[1], end: hm[2], room,
        });
      }
    }
  }
  return sessions;
}

// "26.oct" → [fecha]; "09.sep-09.dic" → ese día de la semana, cada semana, entre las dos fechas.
export function expandDates(spec, year) {
  const [a, b] = spec.split("-");
  const start = toDate(a, year);
  if (!start) return [];
  if (!b) return [iso(start)];
  const end = toDate(b, year);
  const out = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 7)) out.push(iso(d));
  return out;
}

// Curso académico: de septiembre a diciembre es `year`, de enero a agosto es `year + 1`.
function toDate(s, year) {
  const m = /^(\d{1,2})\.([a-z]{3})/i.exec(s.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return new Date(Date.UTC(month >= 9 ? year : year + 1, month - 1, +m[1]));
}

export async function fetchSchedule(cfg = UC3M_CONFIG) {
  const all = [];
  for (const p of cfg.pages) {
    const res = await fetch(pageUrl(cfg, p), { headers: { "user-agent": "taskbot-calendar" } });
    if (!res.ok) throw new Error(`horarios UC3M ${res.status} (${p.curso}º grp ${p.grupo})`);
    all.push(...parseTimetable(await res.text(), cfg.year));
  }
  for (const [name, dates] of cfg.fixed) {
    for (const date of dates) {
      all.push({ key: `fixed|${name}|${date}`, code: "fixed", subject: name, group: "", type: "TEORÍA",
        date, start: "14:00", end: "15:30", room: "Virtual" });
    }
  }
  const wanted = cfg.subjects;
  const seen = new Set();
  return all.filter((s) => {
    if (s.code === "fixed") return true;
    if (wanted[s.code] === undefined || String(wanted[s.code].group) !== s.group) return false;
    if (seen.has(s.key)) return false;
    seen.add(s.key);
    s.subject = wanted[s.code].name || s.subject;
    return true;
  }).sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
}

const iso = (d) => d.toISOString().slice(0, 10);
const match = (s, re) => re.exec(s)?.[1] || "";

function text(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&ordm;/g, "º").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase())
    .replace(/\b(De|Del|La|Las|Los|Y|E|En|El|A)\b/g, (w) => w.toLowerCase());
}
