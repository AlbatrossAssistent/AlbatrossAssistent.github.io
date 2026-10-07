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
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
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

// ---------- turning the host PC on (smart plug + Alexa routine) ----------
// POWER_ON_URL: a secret link that runs an Alexa routine turning the PC's smart plug on
//   (for example from Voice Monkey or Virtual Smart Home). With "Restore on AC power loss"
//   set to On in the PC's BIOS, the PC then boots by itself.
// POWER_PIN: a PIN you choose; the website asks for it before turning the PC on.
const POWER_ON_URL = process.env.POWER_ON_URL || "";
const POWER_PIN = process.env.POWER_PIN || "";
let lastPowerOn = 0;
const powerFails = []; // times of wrong PINs, from anyone; counted together so faked addresses don't help
function handlePower(req, res, url) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const available = !!(POWER_ON_URL && POWER_PIN);
  if (url.pathname === "/power/status") return sendJson(res, 200, { available });
  if (url.pathname !== "/power/on" || req.method !== "POST") return sendJson(res, 404, { error: "Not found" });
  if (!available) return sendJson(res, 501, { error: "Turning the PC on isn't set up on the server (POWER_ON_URL and POWER_PIN)." });

  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
  req.on("end", async () => {
    const ip = clientIp(req);
    while (powerFails.length && Date.now() - powerFails[0] > 60 * 60 * 1000) powerFails.shift();
    if (tooManyFailures(ip) || powerFails.length >= 20) {
      return sendJson(res, 429, { error: "Too many wrong PINs. Turning the PC on is locked for up to an hour." });
    }
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const pinOk = typeof body.pin === "string" && crypto.timingSafeEqual(Buffer.from(sha(body.pin), "hex"), Buffer.from(sha(POWER_PIN), "hex"));
    if (!pinOk) { noteFailure(ip); powerFails.push(Date.now()); return sendJson(res, 403, { error: "Wrong PIN" }); }

    // Never needed while the PC is online, and the routine should only ever turn power ON.
    const code = String(body.code || "").toUpperCase();
    if (CODE_RE.test(code) && hosts.has(code)) return sendJson(res, 409, { error: "The PC is already on and connected." });
    if (Date.now() - lastPowerOn < 60 * 1000) return sendJson(res, 200, { ok: true, again: true });

    try {
      const r = await fetch(POWER_ON_URL, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
    } catch (e) {
      console.log("[power] trigger failed:", e.message);
      return sendJson(res, 502, { error: "Couldn't reach the Alexa trigger (" + e.message + ")." });
    }
    lastPowerOn = Date.now();
    console.log("[power] PC turn-on triggered");
    sendJson(res, 200, { ok: true });
  });
}

function handleTools(req, res, url) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/tools/status") return sendJson(res, 200, { webSearch: !!OLLAMA_API_KEY });
  const name = url.pathname.slice("/tools/".length);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname.startsWith("/relay/")) return handleRelay(req, res, url);
  if (url.pathname.startsWith("/tools/")) return handleTools(req, res, url);
  if (url.pathname.startsWith("/power/")) return handlePower(req, res, url);

  // static files
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
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
function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

// ---------- WebSocket for host PCs ----------
const wss = new WebSocketServer({ server, path: "/host", maxPayload: 80 * 1024 * 1024 });

wss.on("connection", (ws) => {
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
      return safeSend(ws, { type: "registered", code });
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

// keep connections alive through proxies, drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Burrow server running on http://localhost:${PORT}`);
  console.log(OLLAMA_API_KEY ? "Web search: on" : "Web search: off (set OLLAMA_API_KEY to turn it on)");
});
