// Fail-safe de motion (como el portfolio): sin animaciones con ?motion=off, reduce motion o en prerender,
// para que nada se quede escondido a opacity 0. Va en <head> y síncrono: se aplica antes del primer pintado.
(() => {
  const r = document.documentElement;
  const off = new URLSearchParams(location.search).get("motion") === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (off || document.prerendering) r.classList.add("motion-off");
  if (!off && document.prerendering) document.addEventListener("prerenderingchange", () => r.classList.remove("motion-off"), { once: true });
})();
