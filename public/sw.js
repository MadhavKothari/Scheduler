// Minimal app-shell cache: makes the app installable and gives it an
// offline fallback. This is deliberately NETWORK-FIRST — it always tries to
// fetch the latest version first, and only falls back to whatever's cached
// if the network request fails (i.e., you're actually offline). A cache-first
// strategy would silently keep serving an old build after every redeploy,
// which is the opposite of what you want on a project that's still changing.
const CACHE_NAME = "slate-shell-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
