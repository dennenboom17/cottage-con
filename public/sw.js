// Cottage Con Service Worker
//
// Browsers only re-install this worker when this file's bytes change, and activating the new one deletes every older
// cache. So bump CACHE_NAME in any deploy that must reach installed users straight away (new icons, manifest, ...).
const CACHE_NAME = "cottage-con-v3";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    // cache: "reload" skips the browser's HTTP cache, so a fresh deploy is never precached from a stale copy
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: "reload" })))
    )
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

// Only cache valid same-origin responses
function cacheIfValid(request, response) {
  if (
    !response ||
    response.status !== 200 ||
    response.type === "opaque" ||
    response.type === "error"
  ) {
    return;
  }
  // Clone BEFORE the body is read — the clone goes to cache, the original to the browser
  const toCache = response.clone();
  caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
}

function cacheFirst(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      cacheIfValid(request, response);
      return response;
    });
  });
}

// Used for anything that can change at the same URL (the page, manifests, icons): always ask the network first so an
// installed app picks up a deploy, and fall back to the cache only when offline.
function networkFirst(request) {
  return fetch(request)
    .then(response => {
      cacheIfValid(request, response);
      return response;
    })
    .catch(() =>
      caches.match(request).then(cached => {
        if (cached) return cached;
        // Offline fallback for navigation requests
        if (request.mode === "navigate") return caches.match("/index.html");
      })
    );
}

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

  // Vite's /assets/* files are content-hashed, so a cached copy can never be stale
  const hashed = url.pathname.startsWith("/assets/");
  event.respondWith(hashed ? cacheFirst(request) : networkFirst(request));
});
