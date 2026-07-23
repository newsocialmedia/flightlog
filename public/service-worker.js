// ═══════════════════════════════════════════════════════════════════════════
// AviateSync Service Worker — v12 (network-first, self-healing, real push)
// v12: adds actual Web Push handling -- a `push` event listener that turns
// an incoming push message into a real, visible notification, and a
// `notificationclick` handler that focuses an existing app window or opens
// a new one to the right page. Previously this app had a service worker
// (a hard requirement for push) but nothing listening for push events at
// all -- the notification bell only ever showed things while the app was
// open; nothing reached the device when it was closed.
// v11: live-data hosts (RainViewer radar, Nominatim geocoding, OurAirports
// dataset) added to the never-touch list. Radar is REAL-TIME data — RainViewer
// purges tile frames after ~2 hours, so a cached frame list served by the
// offline fallback produced tile URLs that all 404'd silently: the app saw a
// "successful" fetch (so its own retry/failure handling never engaged) and
// showed a green "Live" badge over an empty radar layer. The version bump
// also flushes any such poisoned entries already sitting in clients' caches.
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = "aviatesync-v12";

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

// ═══════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════

// A push message's payload is whatever the server put in it -- there's no
// guarantee it's valid JSON, or that it has the fields this code expects,
// since a malformed or unexpected payload should never make this handler
// throw. A service worker exception inside a push handler fails SILENTLY
// (no visible error anywhere a person would ever see it), so every step
// here degrades to a safe, generic fallback rather than risk that.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Not valid JSON -- fall back to plain text, or nothing at all.
    try { payload = { body: event.data ? event.data.text() : "" }; } catch { payload = {}; }
  }

  const title = payload.title || "AviateSync";
  const options = {
    body: payload.body || "You have a new notification.",
    icon: payload.icon || "/icons/icon192.png",
    badge: payload.badge || "/icons/icon192.png",
    tag: payload.tag || undefined, // same tag replaces a still-showing notification instead of stacking a duplicate
    data: {
      // Where notificationclick should send the person -- a real page
      // name this app's own navigate() function already understands
      // (e.g. "logbook", "dashboard"), not a raw URL, since this is a
      // single-page app where the actual route lives in app state, not
      // the browser's address bar.
      page: payload.page || "dashboard",
      url: payload.url || "/",
    },
    requireInteraction: !!payload.requireInteraction,
    vibrate: payload.silent ? undefined : [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification: focus an already-open app window if one
// exists (and tell it, via postMessage, which page to navigate to --
// since this is a single-page app, a window that's already open should
// navigate in place rather than reload), or open a new window/tab to the
// app's root if none is open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPage = event.notification.data?.page || "dashboard";
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        // An existing app window -- focus it and tell it where to go,
        // rather than force a full reload just to change pages.
        if ("focus" in client) {
          client.postMessage({ type: "PUSH_NOTIFICATION_CLICKED", page: targetPage });
          return client.focus();
        }
      }
      // No app window open at all -- open a fresh one.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
