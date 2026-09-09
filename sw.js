// Service worker de Aire Saladillo — solo cachea el "app shell" (el HTML,
// el manifest y los íconos) para que la app instalada abra rápido y no
// quede en blanco si por un momento no hay señal. Los datos en vivo (API
// propia) y las librerías de CDN (Chart.js, jsPDF, Leaflet, fuentes,
// design.lemeit.ar) NUNCA se cachean acá: van directo a red, así siempre
// se ven lecturas actuales y versiones al día de esas librerías.
const CACHE_NAME = "aq-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.svg",
  "./favicon-32x32.png",
  "./favicon-16x16.png",
  "./apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo interceptamos GET del propio origen (el shell). Todo lo demás
  // (API de datos, CDNs) sigue su camino normal, sin pasar por acá.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  const isNavigation = req.mode === "navigate" || url.pathname.endsWith(".html");

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);

      // El HTML va "network-first" (para no quedar pegado a una versión
      // vieja del sitio apenas hay conexión); el resto del shell (íconos,
      // manifest) es "cache-first" — cambian poco y priorizamos velocidad.
      return isNavigation ? networkFetch : cached || networkFetch;
    })
  );
});
