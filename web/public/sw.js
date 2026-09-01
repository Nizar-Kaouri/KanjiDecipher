/* Kanji Decipher service worker.
 * - precache the core shell + static assets
 * - static assets: cache-first, refresh in the background
 * - pages (/, /kanji/*, /browse, ...): network-first, fall back to cache offline
 *   so any kanji page you've already opened works without a connection
 * Not offline-first: a page you've never visited still needs the network.
 */
const CACHE = "kd-v4";

const PRECACHE = [
  "/",
  "/styles.css",
  "/theme.js",
  "/lang.js",
  "/suggest.js",
  "/stroke-anim.js",
  "/home.js",
  "/radicals.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Matches /search and /api/... whether or not a /xx language prefix is present.
const NEVER_CACHE_RE = /^\/(?:[a-z]{2}\/)?(?:api\/|search$|search\?)|^\/(?:sitemap[\w-]*\.xml|robots\.txt|sw\.js)$/;
const STATIC_RE = /\.(?:css|js|png|svg|ico|webmanifest|woff2?)$/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_RE.test(url.pathname + url.search)) return;

  // Static assets — cache-first, revalidate in the background.
  if (STATIC_RE.test(url.pathname) || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const fromNet = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || fromNet;
      }),
    );
    return;
  }

  // Pages — network-first, cache the HTML, fall back to cache (then home) offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const ct = res.headers.get("content-type") || "";
        if (res.ok && ct.includes("text/html")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("/")),
      ),
  );
});
