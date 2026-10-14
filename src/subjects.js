// Agrupación de tareas para el panel: un área (uni, trabajo, personal…) y, dentro de la uni, la asignatura.
// Se calcula al leer, a partir de la categoría y del texto ("Entregar: práctica 1 · Estructura de Computadores"),
// con los nombres y alias de config.uc3m.subjects. No toca la base de datos.

import config from "../config.js";

export const UNI = "uni";
const norm = (s) => ` ${String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

// Patrones de cada asignatura, de más largo a más corto: el nombre completo gana a un alias ambiguo ("software").
const PATTERNS = Object.values(config.uc3m?.subjects || {})
  .flatMap((s) => [s.name, ...(s.alias || [])].map((p) => ({ subject: s.name, p: norm(p), full: p === s.name })))
  .filter((x) => x.p.trim())
  .sort((a, b) => b.full - a.full || b.p.length - a.p.length);

// `strict`: sin alias cortos ("ia", "so", "ec"), para textos que no se sabe si son de la uni.
export function subjectOf(text, { strict = false } = {}) {
  const t = norm(text);
  return PATTERNS.find((x) => (!strict || x.full || x.p.trim().length > 3) && t.includes(x.p))?.subject || null;
}

/** { area, subject } de un item. Lo de Aula Global, lo de categoría "uni" y lo que nombra una asignatura es de la uni. */
export function groupOf(item) {
  const cat = String(item.category || "").trim().toLowerCase();
  const fromAula = /^(ag|crono):/.test(item.source || "");
  const subject = cat === UNI || fromAula ? subjectOf(item.text) : !cat ? subjectOf(item.text, { strict: true }) : null;
  if (cat === UNI || fromAula || subject) return { area: UNI, subject };
  return { area: cat || null, subject: null };
}

export const withGroup = (item) => ({ ...item, ...groupOf(item) });

/** Orden de las asignaturas: el de config.js. */
export const SUBJECT_ORDER = Object.values(config.uc3m?.subjects || {}).map((s) => s.name);
