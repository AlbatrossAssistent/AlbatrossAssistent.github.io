// Albatross service worker:
// - makes the app installable and lets it open without a connection (the page itself, never your chats or answers),
// - keeps sending files to your PC after the page was closed (best effort: the browser decides how long a worker may run).
importScripts("xfer.js");

const CACHE = "albatross-shell-v1";
const SHELL = ["./", "index.html", "network.js", "notes.js", "mail.js", "music.js", "hub.js", "scenes.js", "orb.js", "xfer.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Pages and scripts of the app: the live version when there's a connection, the saved one without.
// Everything else (the server, the PC, Ollama, fonts) is never touched.
const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, self.registration.scope).href));
self.addEventListener("fetch", (e) => {
  const r = e.request, url = new URL(r.url);
  if (r.method !== "GET" || url.origin !== location.origin || r.headers.has("range")) return;
  const plain = url.origin + url.pathname;
  if (!SHELL_URLS.has(plain) && !(r.mode === "navigate" && plain.startsWith(self.registration.scope))) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then((hit) => hit || (r.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});

// Unfinished files: carry on when the browser says we're online, or when the page tells us it's closing.
self.addEventListener("sync", (e) => {
  if (e.tag === "albatross-upload") e.waitUntil(AlbatrossXfer.runPending({ rounds: 60, wait: 3000 }).then((ok) => { if (!ok) throw new Error("unfinished"); }));
});
self.addEventListener("message", (e) => {
  if (e.data && e.data.t === "resume") e.waitUntil(AlbatrossXfer.runPending({ rounds: 60, wait: 3000 }));
});
