// Burrow relay server
// - Serves the website from ./public
// - Lets a "host" PC (running host/host.js next to Ollama) register with an XXXX-XXXX code
// - Forwards requests from /relay/<CODE>/api/... to that PC and streams the answer back
//
// Run:  npm install  &&  node server.js        (PORT env var, default 8080)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// Load settings from a .env file next to this script (KEY=value per line), if there is one.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 60 * 1024 * 1024;           // 60 MB (images are sent as base64)
const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;  // image generation can be slow
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// Only these Ollama endpoints can be reached through the relay.
// Nothing that deletes, pulls or changes models.
const ALLOWED = new Set([
  "GET /api/tags",
  "GET /api/ps",
  "GET /api/version",
  "POST /api/show",
  "POST /api/chat",
  "POST /api/generate",
  // End-to-end encrypted request: the server can't read it, the host PC decrypts it and
  // applies the same list above. Current host PCs accept only this.
  "POST /e2e",
]);

const hosts = new Map(); // code -> { ws, name, secretHash, pending: Map<id, {res, timer}> }
const failures = new Map(); // ip -> { count, since }

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// ---------- brute-force protection for wrong codes ----------
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 10 * 60 * 1000) { failures.delete(ip); return false; }
  return f.count >= 30;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 10 * 60 * 1000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}
setInterval(() => {
  for (const [ip, f] of failures) if (Date.now() - f.since > 10 * 60 * 1000) failures.delete(ip);
}, 60 * 1000).unref();

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
}

// ---------- web search tools (uses Ollama's web search API) ----------
// Set OLLAMA_API_KEY on the server (free key: https://ollama.com/settings/keys)
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const WEB_API = (process.env.OLLAMA_WEB_API || "https://ollama.com/api").replace(/\/+$/, "");
const searchUse = new Map(); // ip -> { count, since }
function searchLimited(ip) {
  const u = searchUse.get(ip);
  if (!u || Date.now() - u.since > 10 * 60 * 1000) { searchUse.set(ip, { count: 1, since: Date.now() }); return false; }
  return ++u.count > 60;
}
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + " …" : s || "");

// ---------- photos from the web ----------
// Freely licensed photos only (Openverse: Creative Commons / public domain; Wikimedia Commons as backup),
// so they can be shown and reused with credit. No key needed. Returns small previews plus credits.
function imageSearch(req, res) {
  if (searchLimited(clientIp(req))) return sendJson(res, 429, { error: "Too many searches — wait a few minutes." });
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on("end", async () => {
    let args = {};
    try { args = JSON.parse(body || "{}"); } catch {}
    const query = String(args.query || "").trim().slice(0, 200);
    const count = Math.min(Math.max(Number(args.count) || 6, 1), 12);
    if (!query) return sendJson(res, 400, { error: "Empty query" });
    const ua = { "User-Agent": "AlbatrossBot/1.0 (https://albatrossassistent.github.io)" };
    let images = [];
    try {
      const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${count}&mature=false`, { headers: ua, signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      images = (j.results || []).map((x) => ({
        title: clip(x.title || query, 120), thumb: x.thumbnail || x.url, full: x.url, page: x.foreign_landing_url || x.url,
        creator: clip(x.creator || "", 80), license: (x.license ? "CC " + x.license.toUpperCase() + (x.license_version ? " " + x.license_version : "") : "").replace("CC PDM", "Public domain").replace("CC CC0", "CC0"),
        source: x.source || x.provider || "",
      }));
    } catch {}
    if (images.length < count) {
      try {
        const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${count}&gsrsearch=${encodeURIComponent(query + " filetype:bitmap")}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640`;
        const j = await (await fetch(u, { headers: ua, signal: AbortSignal.timeout(12000) })).json();
        const strip = (h) => String(h || "").replace(/<[^>]+>/g, "").trim();
        for (const pg of Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index)) {
          const ii = pg.imageinfo?.[0]; if (!ii) continue;
          const md = ii.extmetadata || {};
          images.push({ title: clip(pg.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""), 120), thumb: ii.thumburl || ii.url, full: ii.url, page: ii.descriptionurl,
            creator: clip(strip(md.Artist?.value), 80), license: strip(md.LicenseShortName?.value), source: "Wikimedia Commons" });
          if (images.length >= count) break;
        }
      } catch {}
    }
    if (!images.length) return sendJson(res, 200, { images: [], note: "No free photos found for that." });
    sendJson(res, 200, { images: images.slice(0, count) });
  });
}

function handleTools(req, res, url) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/tools/status") return sendJson(res, 200, { webSearch: !!OLLAMA_API_KEY, imageSearch: true });
  const name = url.pathname.slice("/tools/".length);
  if (name === "image_search" && req.method === "POST") return imageSearch(req, res);
  if (req.method !== "POST" || !["web_search", "web_fetch"].includes(name)) return sendJson(res, 404, { error: "Unknown tool" });
  if (!OLLAMA_API_KEY) return sendJson(res, 501, { error: "Web search isn't set up on the server (OLLAMA_API_KEY missing)." });
  if (searchLimited(clientIp(req))) return sendJson(res, 429, { error: "Too many searches — wait a few minutes." });

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on("end", async () => {
    let args;
    try { args = JSON.parse(body || "{}"); } catch { return sendJson(res, 400, { error: "Bad JSON" }); }
    try {
      let payload;
      if (name === "web_search") {
        const query = String(args.query || "").slice(0, 400);
        if (!query) return sendJson(res, 400, { error: "Empty query" });
        payload = { query, max_results: Math.min(Math.max(Number(args.max_results) || 5, 1), 10) };
      } else {
        const u = String(args.url || "");
        if (!/^https?:\/\//i.test(u)) return sendJson(res, 400, { error: "Only http(s) URLs can be fetched" });
        payload = { url: u };
      }
      const r = await fetch(`${WEB_API}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OLLAMA_API_KEY}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return sendJson(res, 502, { error: j.error || `Search service returned ${r.status}` });
      if (name === "web_search") {
        return sendJson(res, 200, { results: (j.results || []).map((x) => ({ title: x.title || x.url, url: x.url, content: clip(x.content, 1500) })) });
      }
      return sendJson(res, 200, { title: j.title || "", content: clip(j.content, 8000), links: (j.links || []).slice(0, 20) });
    } catch (e) {
      sendJson(res, 502, { error: "Search failed: " + e.message });
    }
  });
}

// ---------- version and live settings ----------
// GET /version: the app's version this server was deployed with (read from public/app.js), and settings that can be changed
// WITHOUT a push to GitHub: put JSON into the ALBATROSS_CONFIG environment variable on Render (Dashboard -> the service ->
// Environment). Render restarts the server with it; the website asks for it when it opens and every few minutes. Understood keys:
//   notice      a line shown once to everyone (change the text to show it again), e.g. "Maintenance tonight 22:00"
//   minVersion  copies older than this (like "2026-11-12.3") are asked to reload
//   flags       anything else, readable in the page as window.liveConfig.flags
const DEPLOYED_VERSION = (() => { try { return (/const APP_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8")) || [])[1] || ""; } catch { return ""; } })();
function liveConfig() {
  try { const j = JSON.parse(process.env.ALBATROSS_CONFIG || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return { error: "ALBATROSS_CONFIG isn't valid JSON" }; }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/version") {
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ version: DEPLOYED_VERSION, config: liveConfig(), at: Date.now() }));
  }

  if (url.pathname.startsWith("/relay/")) return handleRelay(req, res, url);
  if (url.pathname.startsWith("/tools/")) return handleTools(req, res, url);
  if (url.pathname === "/power/wake") return handleWake(req, res);

  // static files
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", ...(/\.(html|webmanifest)$|sw\.js$/.test(file) ? { "Cache-Control": "no-cache" } : {}) });
    res.end(data);
  });
});

function handleRelay(req, res, url) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // /relay/ABCD-EFGH/api/chat
  const m = url.pathname.match(/^\/relay\/([A-Za-z0-9-]+)(\/.*)$/);
  if (!m) return sendJson(res, 404, { error: "Bad relay path" });
  let code = m[1].toUpperCase().replace(/-/g, "");
  code = code.slice(0, 4) + "-" + code.slice(4);
  const apiPath = m[2];
  const ip = clientIp(req);

  if (tooManyFailures(ip)) return sendJson(res, 429, { error: "Too many wrong codes. Try again in 10 minutes." });

  const host = CODE_RE.test(code) ? hosts.get(code) : null;
  if (!host) {
    noteFailure(ip);
    return sendJson(res, 404, { error: "No device is online with that code." });
  }

  if (apiPath === "/status") return sendJson(res, 200, { online: true, name: host.name });

  const key = `${req.method} ${apiPath}`;
  if (!ALLOWED.has(key)) return sendJson(res, 403, { error: `Not allowed through the relay: ${key}` });

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { sendJson(res, 413, { error: "Request too large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => finish(host, id, "Timed out waiting for the device"), RESPONSE_TIMEOUT_MS);
    host.pending.set(id, { res, timer });
    host.ws.send(JSON.stringify({
      type: "req", id, method: req.method, path: apiPath,
      body: req.method === "POST" ? Buffer.concat(chunks).toString("utf8") : undefined,
    }));
    // browser hit "stop" or closed the tab -> tell the PC to stop generating
    res.on("close", () => {
      if (host.pending.has(id)) {
        clearTimeout(host.pending.get(id).timer);
        host.pending.delete(id);
        safeSend(host.ws, { type: "abort", id });
      }
    });
  });
}

function finish(host, id, errorText) {
  const p = host.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  host.pending.delete(id);
  if (errorText) {
    if (!p.res.headersSent) sendJson(p.res, 502, { error: errorText });
    else p.res.end();
  } else p.res.end();
}
// ---------- Wake-on-LAN ----------
// The PC is off, so nothing on it can help. The server sends a "magic packet" (UDP) to the home's public
// address, which a router can pass on to the PC, and also knocks on a TCP port there: a FRITZ!Box with
// "start this computer automatically when it is accessed from the internet" wakes the PC on that.
// Nothing is stored; the browser sends the address, port and network card (MAC) with each request.
const dgram = require("dgram");
const net = require("net");
const wakeUse = new Map(); // ip -> times
function handleWake(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  const ip = clientIp(req), now = Date.now();
  const times = (wakeUse.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (times.length >= 12) return sendJson(res, 429, { error: "Too many wake-ups. Wait a few minutes." });
  times.push(now); wakeUse.set(ip, times);
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 2000) req.destroy(); });
  req.on("end", async () => {
    let b = {};
    try { b = JSON.parse(raw || "{}"); } catch {}
    const mac = String(b.mac || "").replace(/[^0-9a-f]/gi, "");
    const host = String(b.host || "").trim();
    const port = Math.min(65535, Math.max(1, Number(b.port) || 9));
    if (mac.length !== 12) return sendJson(res, 400, { error: "That network card address (MAC) doesn't look right." });
    if (!/^[a-z0-9.-]{3,253}$/i.test(host) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))
      return sendJson(res, 400, { error: "Enter your home's public address (for example its MyFRITZ! address), not a local one." });
    const packet = Buffer.alloc(102, 0xff);
    const m = Buffer.from(mac, "hex");
    for (let i = 0; i < 16; i++) m.copy(packet, 6 + i * 6);
    const sock = dgram.createSocket("udp4");
    const sent = await new Promise((done) => {
      let n = 0, ok = 0;
      for (let i = 0; i < 3; i++) sock.send(packet, port, host, (err) => { if (!err) ok++; if (++n === 3) { sock.close(); done(ok); } });
    }).catch(() => 0);
    // the knock: just opening a connection is enough for a router that starts the PC on access
    const knock = await new Promise((done) => {
      const c = net.connect({ host, port: Number(b.knockPort) || port, timeout: 3000 });
      const end = (r) => { c.destroy(); done(r); };
      c.on("connect", () => end("open")); c.on("timeout", () => end("waiting")); c.on("error", (e) => end(e.code || "error"));
    });
    sendJson(res, 200, { ok: true, sent, knock });
  });
}

function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

// ---------- WebSockets: /host for host PCs, /peer for people sending files to their contacts ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 80 * 1024 * 1024 });
const peerWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname;
  const target = p === "/host" ? wss : p === "/peer" ? peerWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const publicIp = req ? clientIp(req) : "";
  let myCode = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "register") {
      const code = String(msg.code || "").toUpperCase();
      if (!CODE_RE.test(code) || !msg.secret) return safeSend(ws, { type: "error", error: "Invalid code or secret" });
      const existing = hosts.get(code);
      if (existing && existing.secretHash !== sha(msg.secret)) {
        return safeSend(ws, { type: "error", error: "code-in-use" });
      }
      if (existing && existing.ws !== ws) {
        for (const id of existing.pending.keys()) finish(existing, id, "Device reconnected");
        try { existing.ws.close(); } catch {}
      }
      myCode = code;
      hosts.set(code, { ws, name: String(msg.name || "PC").slice(0, 60), secretHash: sha(msg.secret), pending: new Map() });
      console.log(`[relay] device online: ${code} (${msg.name || "PC"})`);
      return safeSend(ws, { type: "registered", code, ip: publicIp });
    }

    const host = myCode && hosts.get(myCode);
    if (!host || host.ws !== ws) return;
    const p = host.pending.get(msg.id);
    if (!p) return;

    if (msg.type === "head") {
      if (!p.res.headersSent) p.res.writeHead(msg.status || 200, { "Content-Type": msg.contentType || "application/json" });
    } else if (msg.type === "chunk") {
      if (!p.res.headersSent) p.res.writeHead(200, { "Content-Type": "application/json" });
      p.res.write(msg.data);
    } else if (msg.type === "end") {
      finish(host, msg.id);
    } else if (msg.type === "fail") {
      finish(host, msg.id, msg.error || "Device error");
    }
  });

  ws.on("close", () => {
    const host = myCode && hosts.get(myCode);
    if (host && host.ws === ws) {
      for (const id of [...host.pending.keys()]) finish(host, id, "Device went offline");
      hosts.delete(myCode);
      console.log(`[relay] device offline: ${myCode}`);
    }
  });
});

// ---------- people: private contacts and file sharing between them ----------
// Nobody is listed. You reach someone by their exact name or their contact code; they get a request, and only after
// they accept do the two of you see each other online and can send files. Each person's contact code is a fingerprint
// of an identity key kept in their browser, and every session key is signed with it (checked here and by the browsers),
// so nobody can pose as someone else. Requests wait here for people who are offline (14 days). Files go browser to
// browser through here, encrypted with a key only the two browsers have; the server can't read them.
const PEOPLE_FILE = path.join(process.env.PEOPLE_DIR || require("os").tmpdir(), "albatross-people.json");
const people = new Map();   // cid -> { ws, sid, name, pub, idpub, sig, watch: Set<cid> }   online now
const sids = new Map();     // session id -> cid
const known = new Map();    // lower-case name -> { cid, name, seen }   names stay reserved for 90 days after last use
const inbox = new Map();    // cid -> [{ t: "request" | "answer", from: { cid, name }, yes, at }]
const MAX_PEERS = 2000, NAME_KEEP = 90 * 864e5, REQ_KEEP = 14 * 864e5;
const CID_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CID_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;
const nameKey = (n) => String(n).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
try {
  const j = JSON.parse(fs.readFileSync(PEOPLE_FILE, "utf8"));
  for (const [k, v] of j.known || []) known.set(k, v);
  for (const [k, v] of j.inbox || []) inbox.set(k, v);
} catch {}
let peopleSaveT = 0;
function savePeople() {
  clearTimeout(peopleSaveT);
  peopleSaveT = setTimeout(() => {
    const now = Date.now();
    for (const [k, v] of known) if (now - v.seen > NAME_KEEP && !people.has(v.cid)) known.delete(k);
    for (const [k, list] of inbox) { const l = list.filter((m) => now - m.at < REQ_KEEP); if (l.length) inbox.set(k, l); else inbox.delete(k); }
    fs.writeFile(PEOPLE_FILE, JSON.stringify({ known: [...known], inbox: [...inbox] }), () => {});
  }, 2000);
}
async function cidOf(raw) {
  const h = crypto.createHash("sha256").update(raw).digest();
  let t = ""; for (let i = 0; i < 16; i++) t += CID_ALPHA[h[i] % 32];
  return t.match(/.{4}/g).join("-");
}
async function verifyIdentity(idpub, sig, pub) {
  try {
    const raw = Buffer.from(idpub, "base64"), subtle = crypto.webcrypto.subtle;
    const k = await subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, Buffer.from(sig, "base64"), Buffer.from(pub));
    return ok ? await cidOf(raw) : "";
  } catch { return ""; }
}
const mutual = (a, b) => !!(a && b && a.watch.has(b.cid) && b.watch.has(a.cid));
const presenceOf = (p) => ({ type: "presence", cid: p.cid, online: true, id: p.sid, name: p.name, pub: p.pub, idpub: p.idpub, sig: p.sig });
function queue(cid, m) {
  const l = (inbox.get(cid) || []).filter((x) => !(x.t === m.t && x.from.cid === m.from.cid));
  l.push(m); inbox.set(cid, l.slice(-100)); savePeople();
}
function deliver(cid, m) {
  const p = people.get(cid);
  if (p) safeSend(p.ws, { type: m.t, from: m.from, yes: m.yes, at: m.at });
  return !!p;
}
peerWss.on("connection", (ws) => {
  let me = null;                 // the entry in people
  let budget = { bytes: 0, since: Date.now() }, reqs = { n: 0, since: Date.now() };
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  let chain = Promise.resolve(); // hello is checked asynchronously: keep messages in order
  ws.on("message", (raw) => { chain = chain.then(() => onMessage(raw)).catch(() => {}); });
  async function onMessage(raw) {
    if (Date.now() - budget.since > 60e3) budget = { bytes: 0, since: Date.now() };
    if ((budget.bytes += raw.length) > 200 * 1024 * 1024) return safeSend(ws, { type: "error", error: "Slow down: too much data this minute." });
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "hello") {
      const name = String(msg.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 32);
      const pub = String(msg.pub || ""), idpub = String(msg.idpub || ""), sig = String(msg.sig || "");
      if (!/^[A-Za-z0-9+/=]{40,200}$/.test(pub) || !/^[A-Za-z0-9+/=]{80,100}$/.test(idpub) || !/^[A-Za-z0-9+/=]{80,100}$/.test(sig)) return safeSend(ws, { type: "error", error: "This page is out of date. Reload it." });
      if (name.length < 2) return safeSend(ws, { type: "error", error: "Pick a name with at least 2 characters." });
      const cid = await verifyIdentity(idpub, sig, pub);
      if (!cid) return safeSend(ws, { type: "error", error: "Couldn't check who you are. Reload the page." });
      if (!people.has(cid) && people.size >= MAX_PEERS) return safeSend(ws, { type: "error", error: "Too many people online, try later." });
      // the same person in another tab or after a reconnect: the newest connection wins
      const old = people.get(cid);
      if (old && old.ws !== ws) { sids.delete(old.sid); try { old.ws.close(4000, "replaced"); } catch {} }
      if (me && me.cid !== cid) { people.delete(me.cid); sids.delete(me.sid); }
      // names can be found, so each one belongs to one person (until it hasn't been used for 90 days)
      const k = nameKey(name), owner = known.get(k);
      const nameTaken = !!owner && owner.cid !== cid && Date.now() - owner.seen < NAME_KEEP;
      if (!nameTaken) {
        for (const [kk, v] of known) if (v.cid === cid && kk !== k) known.delete(kk);   // renamed: free the old name
        known.set(k, { cid, name, seen: Date.now() });
      }
      me = { ws, sid: crypto.randomBytes(8).toString("hex"), cid, name, pub, idpub, sig, watch: old ? old.watch : new Set() };
      people.set(cid, me); sids.set(me.sid, cid); savePeople();
      safeSend(ws, { type: "welcome", id: me.sid, cid, nameTaken });
      // what came while offline: requests stay until answered, answers are delivered once
      const waiting = inbox.get(cid) || [];
      for (const m of waiting) safeSend(ws, { type: m.t, from: m.from, yes: m.yes, at: m.at });
      const left = waiting.filter((m) => m.t === "request");
      if (left.length !== waiting.length) { if (left.length) inbox.set(cid, left); else inbox.delete(cid); savePeople(); }
      // contacts who were already watching see this person come online
      for (const c of me.watch) { const o = people.get(c); if (mutual(me, o)) { safeSend(ws, presenceOf(o)); safeSend(o.ws, presenceOf(me)); } }
      return;
    }
    if (!me || people.get(me.cid) !== me) return;

    // the contacts this person has: only mutual contacts see each other online
    if (msg.type === "watch") {
      const next = new Set((Array.isArray(msg.cids) ? msg.cids : []).map(String).filter((c) => CID_RE.test(c) && c !== me.cid).slice(0, 500));
      const before = new Set([...me.watch].filter((c) => mutual(me, people.get(c))));
      me.watch = next;
      for (const c of next) { const o = people.get(c); if (mutual(me, o) && !before.has(c)) { safeSend(ws, presenceOf(o)); safeSend(o.ws, presenceOf(me)); } }
      for (const c of before) if (!next.has(c)) { const o = people.get(c); if (o) { safeSend(o.ws, { type: "presence", cid: me.cid, online: false }); safeSend(ws, { type: "presence", cid: c, online: false }); } }
      return;
    }
    // ask someone (by exact name or contact code) to become a contact
    if (msg.type === "request") {
      if (Date.now() - reqs.since > 3600e3) reqs = { n: 0, since: Date.now() };
      if (++reqs.n > 30) return safeSend(ws, { type: "request-result", ok: false, q: msg.q, error: "Too many requests this hour. Try again later." });
      const q = String(msg.q || "").trim().slice(0, 40), code = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
      let cid = "", name = "";
      if (code.length === 16 && CID_RE.test(code.match(/.{4}/g).join("-"))) { cid = code.match(/.{4}/g).join("-"); name = (people.get(cid) || [...known.values()].find((v) => v.cid === cid) || {}).name || ""; }
      else { const v = known.get(nameKey(q)); if (v) { cid = v.cid; name = v.name; } }
      if (!cid) return safeSend(ws, { type: "request-result", ok: false, q, error: `Nobody called “${q}” was found. Names have to match exactly, or ask them for their contact code.` });
      if (cid === me.cid) return safeSend(ws, { type: "request-result", ok: false, q, error: "That's you." });
      const m = { t: "request", from: { cid: me.cid, name: me.name }, at: Date.now() };
      queue(cid, m); deliver(cid, m);
      return safeSend(ws, { type: "request-result", ok: true, q, cid, name });
    }
    // accept or decline a request; or take back one you sent ("cancel")
    if (msg.type === "answer" || msg.type === "cancel") {
      const to = String(msg.to || "");
      if (!CID_RE.test(to)) return;
      if (msg.type === "cancel") {
        const l = (inbox.get(to) || []).filter((x) => !(x.t === "request" && x.from.cid === me.cid));
        if (l.length) inbox.set(to, l); else inbox.delete(to);
        savePeople();
        const o = people.get(to); if (o) safeSend(o.ws, { type: "request-cancel", from: { cid: me.cid } });
        return;
      }
      const mine = inbox.get(me.cid) || [], had = mine.some((x) => x.t === "request" && x.from.cid === to);
      const l = mine.filter((x) => !(x.t === "request" && x.from.cid === to));
      if (l.length) inbox.set(me.cid, l); else inbox.delete(me.cid);
      savePeople();
      if (!had) return;                                     // only a real request can be answered
      const m = { t: "answer", from: { cid: me.cid, name: me.name }, yes: !!msg.yes, at: Date.now() };
      if (!deliver(to, m)) queue(to, m);
      return;
    }
    // data for a contact who is online (an offer, a piece of a file…), sealed by the browsers
    if (msg.type === "to") {
      const cid = sids.get(String(msg.to)), to = cid && people.get(cid);
      if (!to || !mutual(me, to)) return safeSend(ws, { type: "gone", id: msg.to });
      try { to.ws.send(JSON.stringify({ type: "from", from: me.sid, msg: msg.msg })); } catch {}
    }
  }
  ws.on("close", () => {
    if (!me || people.get(me.cid) !== me) return;
    people.delete(me.cid); sids.delete(me.sid);
    const v = known.get(nameKey(me.name)); if (v && v.cid === me.cid) { v.seen = Date.now(); savePeople(); }
    for (const c of me.watch) { const o = people.get(c); if (o && o.watch.has(me.cid)) safeSend(o.ws, { type: "presence", cid: me.cid, online: false }); }
  });
});

// keep connections alive through proxies, drop dead ones
setInterval(() => {
  for (const ws of [...wss.clients, ...peerWss.clients]) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Burrow server running on http://localhost:${PORT}`);
  console.log(OLLAMA_API_KEY ? "Web search: on" : "Web search: off (set OLLAMA_API_KEY to turn it on)");
});
