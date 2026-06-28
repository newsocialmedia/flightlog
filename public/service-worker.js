// ═══════════════════════════════════════════════════════════════════════════
// FlightLog Service Worker — v9 (network-first, self-healing)
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = "flightlog-v9";

// Install: activate immediately, don't wait
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Activate: delete ALL old caches and take control immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

// Fetch: ALWAYS network-first. Only fall back to cache when offline.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch API/data requests
  const isApiCall =
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("anthropic.com") ||
    url.hostname.includes("flightaware.com") ||
    url.hostname.includes("aviationweather.gov") ||
    url.pathname.includes("/functions/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/auth/");

  if (isApiCall) {
    return; // let the browser handle it normally
  }

  // Everything else: network-first, cache only as offline fallback
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Cache a copy for offline use
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
