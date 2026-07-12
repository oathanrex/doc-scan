// sw.js — DocScan service worker.
//
// This is intentionally a "self-destruct" / pass-through worker.
//
// Background: an earlier version of DocScan used this file to cache
// the app shell, which sounds like a good idea for a PWA. In
// practice on GitHub Pages it caused a class of hard-to-recover
// failures: when the app was fixed and re-deployed, returning users
// kept running the old, broken JS straight out of the cache and
// saw a completely non-functional app with no obvious cause.
//
// So this worker now does the opposite of what it used to:
//   - on install: takes control immediately (skipWaiting)
//   - on activate: DELETES every cache the browser knows about and
//     unregisters itself, so the next page load is uncached
//   - on fetch: passes everything through to the network
//
// This guarantees that deploying a new version of the app always
// reaches the user, while still letting us ship a sw.js so that
// browsers that require one for PWA install prompts don't complain.

self.addEventListener("install", (event) => {
  // No assets to precache. Take over from any older worker ASAP.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1. Wipe every cache the browser currently has for this origin.
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {
        // ignore — old browsers / private mode
      }
      // 2. Unregister this service worker so future visits don't even
      //    have to go through it.
      try {
        await self.registration.unregister();
      } catch (_) {
        // ignore
      }
      // 3. Force all open clients to reload so they pick up the
      //    un-cached version on the next render.
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const c of clients) {
          try { c.navigate(c.url); } catch (_) {}
        }
      } catch (_) {}
    })()
  );
  // Take control of any uncontrolled clients right away.
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Pure pass-through. Let the browser handle caching per its own
  // HTTP cache headers (which GitHub Pages sets sensibly).
  return;
});
