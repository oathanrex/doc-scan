// sw.js — DocScan Progressive Web App Service Worker
const CACHE_NAME = "docscan-v2.0.0";

const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon.svg",
  "./js/edge-detect.js",
  "./js/perspective.js",
  "./js/pdf-export.js",
  "./js/app.js"
];

// 1. Install & precache core app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn("DocScan: Pre-caching asset warning:", err);
      });
    })
  );
  self.skipWaiting();
});

// 2. Activate & cleanup old caches (NO aggressive client reloads!)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Network-first strategy with cache fallback (ensures fresh code without reload loops)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Skip chrome-extension or external analytics
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
      })
  );
});
