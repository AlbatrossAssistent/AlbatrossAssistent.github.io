// Burrow host — run this on the PC that has Ollama.
// It connects OUT to your Burrow server (no port forwarding needed) and gets an XXXX-XXXX code.
// Anyone who enters that code on the website can use this PC's Ollama, so only share it with people you trust.
//
// Usage:
//   node host.js https://your-server.com          (keeps the same code every time)
//   node host.js https://your-server.com --new    (makes a new code; the old one stops working)
//
// Env: OLLAMA_URL (default http://127.0.0.1:11434), BURROW_NAME (name shown to the other device)

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const args = process.argv.slice(2);
const SERVER = (args.find((a) => !a.startsWith("--")) || process.env.BURROW_SERVER || "").replace(/\/+$/, "");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const NAME = process.env.BURROW_NAME || os.hostname();
const STATE_FILE = path.join(__dirname, "host-code.json");

if (!SERVER) {
  console.log("Usage: node host.js https://your-burrow-server.com [--new]");
  process.exit(1);
}

const ALLOWED = new Set([
  "GET /api/tags", "GET /api/ps", "GET /api/version",
  "POST /api/show", "POST /api/chat", "POST /api/generate",
]);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid typos
function newCode() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}
function loadState(forceNew) {
  if (!forceNew) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  }
  const st = { code: newCode(), secret: crypto.randomBytes(24).toString("hex") };
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return st;
}

let state = loadState(args.includes("--new"));
const wsUrl = SERVER.replace(/^http/, "ws") + "/host";
const running = new Map(); // id -> AbortController
let retry = 1000;

function connect() {
  const ws = new WebSocket(wsUrl, { maxPayload: 80 * 1024 * 1024 });
  const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  ws.on("open", () => {
    retry = 1000;
    send({ type: "register", code: state.code, secret: state.secret, name: NAME });
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "registered") {
      console.log("\n  ┌──────────────────────────────┐");
      console.log(`  │   Your code:   ${msg.code}     │`);
      console.log("  └──────────────────────────────┘");
      console.log(`  Open ${SERVER}/?code=${msg.code} on another device.`);
      console.log("  Keep this window open. Ctrl+C to stop sharing.\n");
      return;
    }
    if (msg.type === "error") {
      if (msg.error === "code-in-use") {
        console.log("That code is taken on the server — making a new one.");
        state = loadState(true);
        send({ type: "register", code: state.code, secret: state.secret, name: NAME });
      } else console.log("Server error:", msg.error);
      return;
    }
    if (msg.type === "abort") {
      running.get(msg.id)?.abort();
      running.delete(msg.id);
      return;
    }
    if (msg.type !== "req") return;

    const { id, method, path: p, body } = msg;
    if (!ALLOWED.has(`${method} ${p}`)) return send({ type: "fail", id, error: "Not allowed" });

    const ctrl = new AbortController();
    running.set(id, ctrl);
    const started = Date.now();
    try {
      const r = await fetch(OLLAMA + p, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
        signal: ctrl.signal,
      });
      send({ type: "head", id, status: r.status, contentType: r.headers.get("content-type") || "application/json" });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        send({ type: "chunk", id, data: dec.decode(value, { stream: true }) });
      }
      send({ type: "end", id });
      if (p !== "/api/tags" && p !== "/api/ps") console.log(`  ${method} ${p}  ${r.status}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      if (e.name !== "AbortError") {
        console.log("  Ollama error:", e.message);
        send({ type: "fail", id, error: "Couldn't reach Ollama on the host PC — is it running?" });
      }
    } finally {
      running.delete(id);
    }
  });

  ws.on("close", () => {
    for (const c of running.values()) c.abort();
    running.clear();
    console.log(`Disconnected from server. Reconnecting in ${retry / 1000}s…`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  });
  ws.on("error", (e) => console.log("Connection problem:", e.message));
}

console.log(`Burrow host — sharing Ollama at ${OLLAMA} via ${SERVER}`);
connect();
