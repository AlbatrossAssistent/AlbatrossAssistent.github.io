// Burrow host — run this on the PC that has Ollama.
// It connects OUT to your Burrow server (no port forwarding needed) and gets an XXXX-XXXX code.
// Anyone who enters that code on the website can use this PC's Ollama, so only share it with people you trust.
//
// Usage:
//   node host.js https://your-server.com          (keeps the same code every time)
//   node host.js https://your-server.com --new    (makes a new code; the old one stops working)
//   add --no-panel to skip opening the control center window
//
// While it runs, the PC is kept from going to sleep (Windows), and a control center
// opens at http://127.0.0.1:4747 showing the code, Ollama status and activity.
//
// Env: OLLAMA_URL (default http://127.0.0.1:11434), BURROW_NAME (name shown to the other device),
//      BURROW_PANEL_PORT (default 4747)

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { startPanel } = require("./panel");

const args = process.argv.slice(2);
const SERVER = (args.find((a) => !a.startsWith("--")) || process.env.BURROW_SERVER || "").replace(/\/+$/, "");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const NAME = process.env.BURROW_NAME || os.hostname();
const STATE_FILE = path.join(__dirname, "host-code.json");

if (!SERVER) {
  console.log("Usage: node host.js https://your-burrow-server.com [--new] [--no-panel]");
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

// ---------- what the control center shows ----------
const stats = {
  name: NAME, server: SERVER, code: state.code, startedAt: Date.now(),
  link: "", connection: "connecting", connectionSince: Date.now(),
  ollama: { up: false, version: "", url: OLLAMA, models: [] },
  awake: false,
  totals: { requests: 0, messages: 0, tokens: 0, errors: 0 },
  active: 0,
  log: [],
};
let panel = { push() {} };
const changed = () => panel.push();
function setConnection(c) { if (stats.connection !== c) { stats.connection = c; stats.connectionSince = Date.now(); } changed(); }
function addLog(entry) {
  stats.log.unshift({ id: crypto.randomUUID(), time: Date.now(), ...entry });
  stats.log.length = Math.min(stats.log.length, 100);
  changed();
  return stats.log[0];
}
function note(text, kind = "info") { addLog({ kind, text }); }

// What a chat/generate request is about, for the activity list.
function describe(p, body) {
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch {}
  if (p === "/api/generate" && !j.prompt && j.keep_alive === 0) return { kind: "unload", model: j.model, text: "Unload model" };
  const last = p === "/api/chat" ? [...(j.messages || [])].reverse().find((m) => m.role === "user") : null;
  const text = String((last ? last.content : j.prompt) || "").replace(/\s+/g, " ").trim();
  const imgs = (last?.images || j.images || []).length;
  return { kind: "chat", model: j.model, text: (text.length > 140 ? text.slice(0, 140) + "…" : text) || (imgs ? "(image)" : "") };
}

function connect() {
  const ws = new WebSocket(wsUrl, { maxPayload: 80 * 1024 * 1024 });
  const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  setConnection("connecting");

  ws.on("open", () => {
    retry = 1000;
    send({ type: "register", code: state.code, secret: state.secret, name: NAME });
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "registered") {
      stats.code = msg.code;
      stats.link = `${SERVER}/?code=${msg.code}`;
      setConnection("online");
      note("Connected to the server, sharing is on");
      console.log("\n  ┌──────────────────────────────┐");
      console.log(`  │   Your code:   ${msg.code}     │`);
      console.log("  └──────────────────────────────┘");
      console.log(`  Open ${stats.link} on another device.`);
      console.log("  Keep this window open. Ctrl+C to stop sharing.\n");
      return;
    }
    if (msg.type === "error") {
      if (msg.error === "code-in-use") {
        console.log("That code is taken on the server — making a new one.");
        note("Code was taken on the server, made a new one", "error");
        state = loadState(true);
        send({ type: "register", code: state.code, secret: state.secret, name: NAME });
      } else { console.log("Server error:", msg.error); note("Server error: " + msg.error, "error"); }
      return;
    }
    if (msg.type === "abort") {
      running.get(msg.id)?.abort();
      running.delete(msg.id);
      return;
    }
    if (msg.type !== "req") return;

    const { id, method, path: p, body } = msg;
    stats.totals.requests++;
    if (!ALLOWED.has(`${method} ${p}`)) { changed(); return send({ type: "fail", id, error: "Not allowed" }); }

    // Model lists, status checks etc. only count; chats and generations get a row in the activity list.
    const isChat = method === "POST" && (p === "/api/chat" || p === "/api/generate");
    const entry = isChat ? addLog({ ...describe(p, body), active: true, tokens: 0 }) : null;
    if (entry?.kind === "chat") stats.totals.messages++;
    stats.active++;
    changed();

    const ctrl = new AbortController();
    running.set(id, ctrl);
    const started = Date.now();
    let tail = "";
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
        const data = dec.decode(value, { stream: true });
        send({ type: "chunk", id, data });
        if (entry) {
          tail = (tail + data).slice(-8192);
          entry.tokens += (data.match(/\n/g) || []).length; // ~1 streamed line per token, exact count comes at the end
          changed();
        }
      }
      send({ type: "end", id });
      if (entry) {
        entry.status = r.status;
        try {
          const last = JSON.parse(tail.trim().split("\n").pop());
          if (last.eval_count) {
            entry.tokens = last.eval_count;
            if (last.eval_duration) entry.tps = last.eval_count / (last.eval_duration / 1e9);
          }
          if (last.load_duration > 1e9) entry.loadSecs = last.load_duration / 1e9;
          if (last.error) entry.error = last.error;
        } catch {}
        if (r.status >= 400 || entry.error) { entry.error = entry.error || "HTTP " + r.status; stats.totals.errors++; }
        else stats.totals.tokens += entry.kind === "chat" ? entry.tokens : 0;
      }
      if (p !== "/api/tags" && p !== "/api/ps") console.log(`  ${method} ${p}  ${r.status}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      if (e.name === "AbortError") { if (entry) entry.stopped = true; }
      else {
        console.log("  Ollama error:", e.message);
        send({ type: "fail", id, error: "Couldn't reach Ollama on the host PC — is it running?" });
        stats.totals.errors++;
        if (entry) entry.error = "Couldn't reach Ollama";
      }
    } finally {
      running.delete(id);
      stats.active--;
      if (entry) { entry.active = false; entry.secs = (Date.now() - started) / 1000; }
      changed();
      if (entry) pollOllama();
    }
  });

  ws.on("close", () => {
    for (const c of running.values()) c.abort();
    running.clear();
    if (stats.connection === "online") note("Lost connection to the server, reconnecting…", "error");
    setConnection("offline");
    console.log(`Disconnected from server. Reconnecting in ${retry / 1000}s…`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  });
  ws.on("error", (e) => console.log("Connection problem:", e.message));
}

// ---------- Ollama status ----------
async function pollOllama() {
  const o = stats.ollama;
  const wasUp = o.up;
  try {
    const ps = await (await fetch(OLLAMA + "/api/ps", { signal: AbortSignal.timeout(2500) })).json();
    o.up = true;
    o.models = (ps.models || []).map((m) => ({ name: m.name, size: m.size, vram: m.size_vram, expires: m.expires_at }));
    if (!o.version) o.version = (await (await fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(2500) })).json()).version || "";
  } catch {
    o.up = false; o.models = []; o.version = "";
  }
  if (wasUp !== o.up) note(o.up ? "Ollama is running" : "Ollama stopped or isn't reachable", o.up ? "info" : "error");
  changed();
}

async function freeGpu() {
  const ps = await (await fetch(OLLAMA + "/api/ps")).json();
  const names = (ps.models || []).map((m) => m.name);
  for (const model of names) {
    await fetch(OLLAMA + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }) });
  }
  note(names.length ? `Freed GPU memory (${names.join(", ")})` : "Free GPU: nothing was loaded");
  await pollOllama();
  return { unloaded: names };
}

// ---------- keep the PC awake ----------
// Asks Windows not to go to sleep while this process runs (like a video player does).
// Doesn't change any power settings; the request ends as soon as the host stops.
// The screen can still turn off.
function keepAwake() {
  if (process.platform !== "win32") return;
  const ps = [
    "$t = Add-Type -Name P -Namespace BurrowAwake -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    "if ($t::SetThreadExecutionState([uint32]2147483649) -ne 0) { 'ok' }", // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 15 }`,
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child.stdout.on("data", (d) => {
    if (String(d).includes("ok") && !stats.awake) { stats.awake = true; note("Sleep mode is blocked while Burrow runs"); console.log("  Sleep mode is blocked while Burrow runs."); }
  });
  child.on("exit", () => { if (stats.awake) { stats.awake = false; note("Sleep blocker stopped", "error"); } });
  child.on("error", () => {});
  const stop = () => child.kill();
  process.on("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stop(); process.exit(0); });
}

// ---------- control center window ----------
function openWindow(url) {
  if (process.platform !== "win32") return console.log(`  Control center: ${url}`);
  // Edge's app mode gives a clean window without tabs; fall back to the default browser.
  const edge = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter(Boolean).map((d) => path.join(d, "Microsoft", "Edge", "Application", "msedge.exe")).find((f) => fs.existsSync(f));
  const child = edge
    ? spawn(edge, [`--app=${url}`, "--window-size=1100,800"], { detached: true, stdio: "ignore" })
    : spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

console.log(`Burrow host — sharing Ollama at ${OLLAMA} via ${SERVER}`);
panel = startPanel({
  port: Number(process.env.BURROW_PANEL_PORT) || 4747,
  getState: () => ({ ...stats, now: Date.now() }),
  actions: { "free-gpu": freeGpu },
  onListening: (url) => {
    console.log(`  Control center: ${url}`);
    if (!args.includes("--no-panel")) openWindow(url);
  },
});
keepAwake();
pollOllama();
setInterval(pollOllama, 3000);
connect();
