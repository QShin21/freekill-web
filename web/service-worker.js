const CACHE_PREFIX = "freekill-web-";
const NETWORK_FIRST = new Set([
  "/",
  "/index.html",
  "/config.json",
  "/asset-manifest.json",
  "/bootstrap.js",
  "/media-pack.js",
  "/FreeKill.js",
  "/FreeKill.worker.js",
  "/qtloader.js",
  "/styles.css",
  "/manifest.webmanifest",
]);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate" || NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
