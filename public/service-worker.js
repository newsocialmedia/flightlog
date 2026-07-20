// ═══════════════════════════════════════════════════════════════════════════
// AviateSync Service Worker — v11 (network-first, self-healing)
// v11: live-data hosts (RainViewer radar, Nominatim geocoding, OurAirports
// dataset) added to the never-touch list. Radar is REAL-TIME data — RainViewer
// purges tile frames after ~2 hours, so a cached frame list served by the
// offline fallback produced tile URLs that all 404'd silently: the app saw a
// "successful" fetch (so its own retry/failure handling never engaged) and
// showed a green "Live" badge over an empty radar layer. The version bump
// also flushes any such poisoned entries already sitting in clients' caches.
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = "aviatesync-v11";

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

  // Never touch API/data requests. Live or validated-by-the-app data must
  // fail HONESTLY when the network fails — a stale cached copy here is
  // worse than an error, because the app can't tell the difference and its
  // own retry / fallback logic never gets the chance to engage.
  const isApiCall =
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("anthropic.com") ||
    url.hostname.includes("flightaware.com") ||
    url.hostname.includes("aviationweather.gov") ||
    url.hostname.includes("rainviewer.com") ||          // live radar (api. + tilecache.) — frames expire in ~2h
    url.hostname.includes("nominatim.openstreetmap.org") || // geocoding — app has its own plausibility-checked cache
    url.hostname.includes("davidmegginson.github.io") ||    // OurAirports dataset — app has its own size-validated cache
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
