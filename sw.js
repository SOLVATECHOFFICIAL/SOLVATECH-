/**
 * SOLVATECH BOT - Progressive Web App Service Worker
 * 
 * Provides an offline app shell for the frontend management console.
 * Strictly enforces network-only for all bot operations, authentication,
 * and sensitive API calls.
 */

const CACHE_NAME = "solvatech-bot-shell-v1";

// Safe static frontend resources for precaching
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./pairing-enhancements.css",
  "./manifest.webmanifest",
  "./solva.webp",
  "./icon-192x192.png",
  "./icon-512x512.png",
  "./icon-maskable-512x512.png",
  "./apple-touch-icon.png",
  "./favicon.svg"
];

// Domains that MUST NEVER be cached
const SENSITIVE_DOMAINS = [
  "identitytoolkit.googleapis.com",
  "securetoken.google.com",
  "firestore.googleapis.com",
  "apis.google.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  "www.googleapis.com"
];

// Installation: Precache the offline app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Add each asset individually so one missing asset doesn't break the whole installation
      await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.debug("[SW] Precache item note for:", url, err.message);
          })
        )
      );
    })
  );
});

// Activation: Clean up any old caches and take control
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Skip waiting when instructed by UI update prompt
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch event handler with strict security rules
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 1. Only handle GET requests. POST, PUT, DELETE, OPTIONS are strictly Network-Only.
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // 2. Strict Security: NEVER cache API, bot, session, license, or auth requests
  if (
    url.pathname.includes("/bot-api/") ||
    url.pathname.includes("/api/") ||
    url.pathname.includes("/sessions") ||
    url.pathname.includes("/license") ||
    request.headers.has("Authorization") ||
    SENSITIVE_DOMAINS.some((domain) => url.hostname.includes(domain))
  ) {
    // Network-only with graceful offline error for API calls
    event.respondWith(
      fetch(request).catch(() => {
        if (url.pathname.includes("/bot-api/")) {
          return new Response(
            JSON.stringify({
              error: "Offline: Internet connection required for bot operations.",
              offline: true,
            }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return new Response("Network unavailable", { status: 503, statusText: "Offline" });
      })
    );
    return;
  }

  // 3. Navigation requests (HTML Pages): Network-First with Cache Fallback
  // Ensures returning users see updates immediately when online, but can still open the app offline.
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // Fallback to cached index.html
          const cachedResponse =
            (await caches.match(request)) ||
            (await caches.match("./index.html")) ||
            (await caches.match("./"));
          if (cachedResponse) {
            return cachedResponse;
          }
          return new Response(
            "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>SOLVATECH BOT - Offline</title></head><body style='background:#102622;color:#f4f1e9;font-family:sans-serif;padding:2rem;text-align:center;'><h1>SOLVATECH BOT</h1><p>You are currently offline. Please check your internet connection and refresh.</p></body></html>",
            {
              headers: { "Content-Type": "text/html" },
            }
          );
        })
    );
    return;
  }

  // 4. Safe Static Assets (CSS, JS, Fonts, Images, Icons, Manifest):
  // Stale-While-Revalidate strategy for fast app shell loading.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed, nothing to do if already cached
        });

      // Return cached version immediately if present, otherwise await network
      return cachedResponse || fetchPromise;
    })
  );
});
