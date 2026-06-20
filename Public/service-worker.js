// ═══════════════════════════════════════════════════════════════════════════════
// FlightLog Service Worker
//
// Caches the app shell (HTML/JS/CSS) so the app loads instantly and works
// offline for already-visited screens. Does NOT cache API calls (Supabase,
// FlightAware, Anthropic) — those always go to the network since they need
// live data.
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_NAME = "flightlog-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches from previous versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for app shell assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API/data requests — these must always be fresh.
  const isApiCall =
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("anthropic.com") ||
    url.hostname.includes("flightaware.com") ||
    url.hostname.includes("aerodatabox") ||
    url.pathname.includes("/functions/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/auth/");

  if (isApiCall) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For navigation/app-shell requests: try network first, fall back to cache
  // (so updates show up immediately when online, but app still loads offline).
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match("/")))
    );
    return;
  }

  // For other static assets (JS/CSS/fonts/images): cache-first for speed.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return res;
      });
    })
  );
});
