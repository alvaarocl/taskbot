// Service worker mínimo: cachea el shell del panel; API, auth y archivos siempre van a red.
const CACHE = "taskbot-v3";
const SHELL = [
  "/", "/style.css", "/app.js", "/passkey.js", "/motion.js", "/manifest.webmanifest",
  "/brand/mark.svg", "/brand/favicon.svg", "/brand/apple-touch-icon.png",
  "/fonts/archivo-latin.woff2", "/fonts/archivo-italic-latin.woff2",
];
const NETWORK_ONLY = /^\/(api|auth|files|internal|cal)\/|^\/(webhook|calendar\.ics)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || NETWORK_ONLY.test(url.pathname) || e.request.method !== "GET") return;
  // Red primero (siempre la última versión); la caché solo sin conexión. /recuperar → el shell.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.pathname !== "/recuperar") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});
