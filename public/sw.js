// Cottage Con Service Worker
const CACHE_NAME = "cottage-con-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and all external/Firebase requests — let browser handle them
  if (
    request.method !== "GET" ||
    url.hostname.includes("firebase") ||
    url.hostname.includes("googleapis") ||
    url.hostname.includes("gstatic") ||
    url.hostname.includes("google") ||
    url.hostname.includes("fonts") ||
    url.hostname.includes("cdn") ||
    url.hostname.includes("jsdelivr") ||
    url.pathname.includes("firebase-messaging-sw") ||
    url.protocol === "chrome-extension:"
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Only cache valid same-origin responses
        if (
          !response ||
          response.status !== 200 ||
          response.type === "opaque" ||
          response.type === "error"
        ) {
          return response;
        }

        // Clone BEFORE reading — the clone goes to cache, original to browser
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === "navigate") {
          return caches.match("/index.html");
        }
      });
    })
  );
});
