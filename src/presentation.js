// Presentación separada de la identidad interna. No modifica títulos almacenados.
export const shortTitle = (value, max = 38) => {
  const text = String(value || "tarea").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
// Solo referencias emitidas por el modelo (#105), no números o hashtags con significado.
export const hideReferences = (value) => String(value || "")
  .replace(/(^|[\s(])#\d+\b/g, "$1").replace(/\(\s*\)/g, "")
  .replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").trim();
