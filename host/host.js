// Burrow host — run this on the PC that has Ollama.
// It connects OUT to your Burrow server (no port forwarding needed) and gets an XXXX-XXXX code.
// Anyone who enters that code on the website can use this PC's Ollama, so only share it with people you trust.
//
// Usage:
//   node host.js                                   (uses the server from last time, or https://burrow-uu7e.onrender.com)
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
const { spawn, execFile } = require("child_process");
const WebSocket = require("ws");
const { startPanel } = require("./panel");
const comfy = require("./comfy");
const files = require("./files");
const jarvis = require("./jarvis");

const STATE_FILE = path.join(__dirname, "host-code.json");
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }

const args = process.argv.slice(2);
// Without a server argument, use the one from last time (the boot-time background task relies on this).
const SERVER = (args.find((a) => !a.startsWith("--")) || process.env.BURROW_SERVER || readState()?.server || "https://burrow-uu7e.onrender.com").replace(/\/+$/, "");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const NAME = process.env.BURROW_NAME || os.hostname();

if (!SERVER) {
  console.log("Usage: node host.js https://your-burrow-server.com [--new] [--no-panel]");
  process.exit(1);
}

const ALLOWED = new Set([
  "GET /api/tags", "GET /api/ps", "GET /api/version",
  "POST /api/show", "POST /api/chat", "POST /api/generate",
]);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid typos
function randomChars(n) {
  const bytes = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
function newCode() { const s = randomChars(8); return s.slice(0, 4) + "-" + s.slice(4); }
function loadState(forceNew) {
  let st = !forceNew && readState();
  let dirty = !st;
  if (!st) st = { code: newCode(), secret: crypto.randomBytes(24).toString("hex") };
  if (!st.key) { st.key = randomChars(8); dirty = true; } // encryption key, the second half of the code
  if (st.server !== SERVER) { st.server = SERVER; dirty = true; }
  if (dirty) fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return st;
}
// The full code: XXXX-XXXX finds this PC on the server, the second half is the key and is never sent anywhere.
const fullCode = (st) => `${st.code}-${st.key.slice(0, 4)}-${st.key.slice(4)}`;

// ---------- end-to-end encryption ----------
// Requests and answers are encrypted with AES-256-GCM using a key made from the second half of the code,
// so the Burrow server only passes along data it can't read or change. public/index.html does the same.
const deriveKey = (st) => crypto.pbkdf2Sync(st.key, "burrow-e2e-v1|" + st.code, 600000, 32, "sha256");
function seal(key, text, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}
function unseal(key, b64, aad) {
  const b = Buffer.from(b64, "base64");
  if (b.length < 29) throw new Error("too short");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8");
}
// Only encrypted requests are accepted: they prove the sender has the full code.
// Each request carries a random id and a time, so a captured request can't be sent again.
const seen = new Map(); // request id -> time
setInterval(() => { for (const [id, t] of seen) if (Date.now() - t > 11 * 60e3) seen.delete(id); }, 60e3).unref();
function openRequest(msg) {
  if (msg.method !== "POST" || msg.path !== "/e2e") throw new Error("This PC only accepts encrypted connections. Reload the page (Ctrl+F5) and enter the full 16-character code.");
  let r;
  try { r = JSON.parse(unseal(aesKey, String(msg.body || "").trim(), "req")); } catch { throw new Error("Wrong code. Check the last 8 characters."); }
  if (typeof r.id !== "string" || !(Math.abs(Date.now() - r.t) < 10 * 60e3)) throw new Error("Request expired. Check that the clock on your device is right.");
  if (seen.has(r.id)) throw new Error("Repeated request rejected");
  seen.set(r.id, Date.now());
  return { rid: r.id, method: r.method, path: r.path, body: r.body };
}

let state = loadState(args.includes("--new"));
let aesKey = deriveKey(state);
const wsUrl = SERVER.replace(/^http/, "ws") + "/host";
const running = new Map(); // id -> AbortController
let retry = 1000;

// ---------- what the control center shows ----------
const stats = {
  name: NAME, server: SERVER, code: fullCode(state), startedAt: Date.now(),
  link: "", connection: "connecting", connectionSince: Date.now(),
  ollama: { up: false, version: "", url: OLLAMA, models: [] },
  awake: false,
  background: args.includes("--background"), // started at boot by Windows, no visible windows
  autostart: null,                           // is the "start at boot" task set up? null = unknown / not Windows
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
  return { kind: "chat", image: comfy.isComfy(j.model), model: j.model, text: (text.length > 140 ? text.slice(0, 140) + "…" : text) || (imgs ? "(image)" : "") };
}

// Only one model in GPU memory at a time: before a model runs, unload every other one
// (Ollama models and ComfyUI), so models don't crowd each other out of the 12 GB.
async function onlyThisModel(model) {
  let loaded = [];
  try { loaded = ((await (await fetch(OLLAMA + "/api/ps", { signal: AbortSignal.timeout(3000) })).json()).models || []).map((m) => m.name); } catch {}
  const others = loaded.filter((n) => n !== model);
  await Promise.all(others.map((m) => fetch(OLLAMA + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m, keep_alive: 0 }) }).catch(() => {})));
  if (!comfy.isComfy(model) && (await comfy.free())) others.push("ComfyUI");
  if (others.length) { note(`Unloaded ${others.join(", ")} to make room for ${model}`); await new Promise((r) => setTimeout(r, 1200)); }
}

// ---------- how far a model has loaded (shown as a percentage on the website) ----------
// Ollama doesn't report loading progress, so we watch the graphics memory fill up
// compared with the model's size (nvidia-smi). Capped at 99% until the model is really ready.
let loading = null; // { model, pct, done, since }
const sizes = {};
function gpuMem() {
  return new Promise((res) => execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 2500 }, (err, out) => {
    if (err) return res(null);
    const [used, total] = String(out).split("\n")[0].split(",").map(Number);
    res(used >= 0 && total > 0 ? { used, total } : null);
  }));
}
async function modelBytes(model) {
  if (comfy.isComfy(model)) return comfy.bytes(model);
  if (!sizes[model]) { try { for (const m of (await (await fetch(OLLAMA + "/api/tags")).json()).models || []) sizes[m.name] = m.size; } catch {} }
  return sizes[model] || 0;
}
// Bytes read from disk so far by the processes that load models (Ollama's llama-server, ComfyUI's python).
// On a slow disk this is what takes the time, so it's the best measure of progress.
function diskRead(comfyToo) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const names = ["llama-server.exe", "ollama.exe", "ollama_llama_server.exe"].concat(comfyToo ? ["python.exe"] : []);
  const filter = names.map((n) => `Name='${n}'`).join(" or ");
  return new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "${filter}" | Measure-Object ReadTransferCount -Sum).Sum`],
    { windowsHide: true, timeout: 4000 }, (err, out) => res(err ? null : Number(String(out).trim()) || 0)));
}
async function isLoaded(model) {
  if (comfy.isComfy(model)) return false;
  try { return ((await (await fetch(OLLAMA + "/api/ps", { signal: AbortSignal.timeout(2000) })).json()).models || []).some((m) => m.name === model); } catch { return false; }
}
async function watchLoad(model) {
  if (!model || (loading && loading.model === model && !loading.done)) return;
  if (await isLoaded(model)) { loading = { model, pct: 100, done: true }; return; }
  const me = (loading = { model, pct: 0, done: false, since: Date.now() });
  const cz = comfy.isComfy(model);
  const [g0, bytes, r0] = await Promise.all([gpuMem(), modelBytes(model), diskRead(cz)]);
  const expect = g0 && bytes ? Math.min(bytes / 1048576, Math.max(512, g0.total - g0.used - 400)) : 0;
  if (!bytes) me.pct = null; // unknown size: the website then shows no number
  // Two measures, whichever is further: bytes read from disk, and graphics memory filled.
  const tick = async () => {
    if (loading !== me || me.done) return;
    if (Date.now() - me.since > 15 * 60e3) { me.done = true; return; }
    if (await isLoaded(model)) return markLoaded(model);
    const [g, r] = await Promise.all([expect ? gpuMem() : null, r0 != null && bytes ? diskRead(cz) : null]);
    let pct = me.pct || 0;
    if (g) pct = Math.max(pct, ((g.used - g0.used) / expect) * 100);
    if (r != null) pct = Math.max(pct, ((r - r0) / bytes) * 100);
    if (bytes) me.pct = Math.min(99, Math.round(pct));
    setTimeout(tick, 800);
  };
  tick();
}
function markLoaded(model) { if (loading && loading.model === model && !loading.done) { loading.done = true; loading.pct = 100; } }
const loadProgress = () => (!loading ? { state: "idle" } : { model: loading.model, pct: loading.pct, state: loading.done ? "loaded" : "loading" });

// Jarvis talks to Ollama directly, so make room on the graphics card before it thinks.
async function freeImageModels() { if (await comfy.free()) note("Unloaded ComfyUI to make room for Jarvis"); }

const isCloud = (name) => typeof name === "string" && /-cloud$|:cloud$|-cloud:/.test(name);

// Ollama, with the ComfyUI image model mixed in (see comfy.js): it shows up in the model list
// and /api/generate for it makes an image, answered in Ollama's format.
async function upstream(method, p, body, signal) {
  let j = null;
  if (method === "POST") { try { j = JSON.parse(body || "{}"); } catch {} }
  const unload = p === "/api/generate" && j && !j.prompt && j.keep_alive === 0;
  // Cloud models run on Ollama's servers, not this PC, so messages would leave the house: never pass them on.
  if (isCloud(j?.model)) return Response.json({ error: "Cloud models are turned off on this PC. Pick a local model." }, { status: 403 });
  if (!unload && j?.model && (p === "/api/chat" || p === "/api/generate")) { await onlyThisModel(j.model); watchLoad(j.model); }
  if (comfy.isComfy(j?.model)) {
    if (unload) { await comfy.free(); return Response.json({ model: j.model, done: true, done_reason: "unload" }); }
    if (p === "/api/show") return Response.json({ capabilities: ["image"], details: comfy.models().find((m) => m.name === j.model)?.details || {} });
    if (p === "/api/generate") {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        async start(c) {
          const emit = (o) => { if (o.total) markLoaded(j.model); c.enqueue(enc.encode(JSON.stringify(o) + "\n")); };
          try { await comfy.generate(j, emit, signal, (t) => note(t)); }
          catch (e) { if (e.name === "AbortError") return c.error(e); emit({ error: e.message }); }
          c.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
  }
  const r = await fetch(OLLAMA + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body, signal });
  if (p === "/api/tags" && r.ok) {
    const t = await r.json();
    t.models = [...(t.models || []).filter((m) => !isCloud(m.name)), ...comfy.models()];
    return Response.json(t);
  }
  if (unload) comfy.free(); // "Free GPU memory" on the website frees ComfyUI's memory too
  return r;
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
      stats.code = fullCode(state);
      // After "#" the browser never sends it to any server, so the key stays private.
      stats.link = `${SERVER}/#code=${stats.code}`;
      setConnection("online");
      note("Connected to the server, sharing is on (end-to-end encrypted)");
      console.log("\n  ┌─────────────────────────────────────────┐");
      console.log(`  │   Your code:   ${stats.code}      │`);
      console.log("  └─────────────────────────────────────────┘");
      console.log(`  Open ${stats.link} on another device.`);
      console.log("  Keep this window open. Ctrl+C to stop sharing.\n");
      return;
    }
    if (msg.type === "error") {
      if (msg.error === "code-in-use") {
        console.log("That code is taken on the server — making a new one.");
        note("Code was taken on the server, made a new one", "error");
        state = loadState(true);
        aesKey = deriveKey(state);
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

    const { id } = msg;
    stats.totals.requests++;
    let req;
    try { req = openRequest(msg); }
    catch (e) {
      stats.totals.errors++;
      note("Rejected a request: " + e.message, "error");
      return send({ type: "fail", id, error: e.message });
    }
    const { rid, method, path: p, body } = req;
    // The answer goes back as encrypted, numbered frames ending with an "end" frame,
    // so the server can't change, reorder or cut off an answer without the browser noticing.
    let seq = 0;
    const reply = (frame) => send({ type: "chunk", id, data: seal(aesKey, JSON.stringify(frame), `${rid}:${seq++}`) + "\n" });
    send({ type: "head", id, status: 200, contentType: "text/plain; charset=utf-8" });
    // Files to and from this PC (see files.js), answered here instead of by Ollama.
    if (typeof p === "string" && p.startsWith("/jarvis/")) {
      let status = 500, out;
      try { [status, out] = await jarvis.handle(method, p, body, note, freeImageModels); } catch (e) { out = { error: e.message }; }
      reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
      if (method === "POST" && p === "/jarvis/ask") note("Jarvis: a message from the website");
      return send({ type: "end", id });
    }
    if (method === "GET" && p === "/load") {
      reply({ k: "m", s: 200, c: "application/json" }); reply({ k: "d", d: JSON.stringify(loadProgress()) }); reply({ k: "e" });
      return send({ type: "end", id });
    }
    if (typeof p === "string" && p.startsWith("/files/")) {
      let status = 500, out;
      try { [status, out] = files.handle(method, p, body, note); } catch (e) { out = { error: e.message }; note("File transfer failed: " + e.message, "error"); }
      reply({ k: "m", s: status, c: "application/json" });
      reply({ k: "d", d: JSON.stringify(out) });
      reply({ k: "e" });
      send({ type: "end", id });
      if (p === "/files/upload-end" || p === "/files/download") changed();
      return;
    }
    if (!ALLOWED.has(`${method} ${p}`)) { changed(); reply({ k: "x", error: "Not allowed" }); return send({ type: "end", id }); }

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
      const r = await upstream(method, p, body, ctrl.signal);
      reply({ k: "m", s: r.status, c: r.headers.get("content-type") || "application/json" });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const data = dec.decode(value, { stream: true });
        reply({ k: "d", d: data });
        if (entry?.model && !entry.image) markLoaded(entry.model); // first words arrived: the model is in memory
        if (entry) {
          tail = (tail + data).slice(-8192);
          if (!entry.image) entry.tokens += (data.match(/\n/g) || []).length; // ~1 streamed line per token, exact count comes at the end
          changed();
        }
      }
      reply({ k: "e" });
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
        reply({ k: "x", error: "Couldn't reach Ollama on the host PC — is it running?" });
        send({ type: "end", id });
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
  if (await comfy.free()) names.push("ComfyUI");
  note(names.length ? `Freed GPU memory (${names.join(", ")})` : "Free GPU: nothing was loaded");
  await pollOllama();
  return { unloaded: names };
}

// ---------- start at boot (Windows scheduled task, see host/autostart.ps1) ----------
const TASK = "Burrow host";
const ROOT = path.join(__dirname, "..");
function checkAutostart() {
  if (process.platform !== "win32") return;
  execFile("schtasks", ["/Query", "/TN", TASK], { windowsHide: true }, (err) => {
    const on = !err;
    if (stats.autostart !== null && stats.autostart !== on) note(on ? "Start at boot turned on" : "Start at boot turned off");
    if (stats.autostart !== on) { stats.autostart = on; changed(); }
  });
}
// Opens autostart-on.bat / -off.bat; Windows then asks for admin rights (and for turning on, your password).
function runAutostartBat(on) {
  if (process.platform !== "win32") throw new Error("Start at boot is only available on Windows");
  if (stats.background) throw new Error(`Burrow is running in the background, so it can't open windows. Double-click autostart-${on ? "on" : "off"}.bat in the Burrow folder instead.`);
  const child = spawn("cmd", ["/c", "start", "", path.join(ROOT, on ? "autostart-on.bat" : "autostart-off.bat")], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  return { opened: true };
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
  // Chrome's or Edge's app mode gives a clean window without tabs; otherwise use the default browser.
  const dirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const browser = [["Google", "Chrome", "Application", "chrome.exe"], ["Microsoft", "Edge", "Application", "msedge.exe"]]
    .flatMap((p) => dirs.map((d) => path.join(d, ...p))).find((f) => fs.existsSync(f));
  const child = browser
    ? spawn(browser, [`--app=${url}`, "--window-size=1100,800"], { detached: true, stdio: "ignore" })
    : spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

console.log(`Burrow host — sharing Ollama at ${OLLAMA} via ${SERVER}`);
panel = startPanel({
  port: Number(process.env.BURROW_PANEL_PORT) || 4747,
  getState: () => ({ ...stats, files: files.state(), now: Date.now() }),
  files,
  // the website on this PC talks to Ollama directly, so it asks here to watch a model load
  load: (model) => { if (model && !isCloud(model)) watchLoad(model); return loadProgress(); },
  jarvis: (method, p, body) => jarvis.handle(method, p, body, note, freeImageModels),
  proxy: (method, p, body, signal) => {
    if (!ALLOWED.has(`${method} ${p}`)) return Response.json({ error: "Not allowed" }, { status: 403 });
    if (method === "POST" && (p === "/api/chat" || p === "/api/generate")) {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      if (j.prompt || j.messages) note(`This PC's website: ${j.model}${comfy.isComfy(j.model) ? " (image)" : ""}`);
    }
    return upstream(method, p, body, signal);
  },
  actions: { "remove-outbox": (b) => { const r = files.removeFromOutbox(b.name); changed(); return r; }, "free-gpu": freeGpu, "autostart-on": () => runAutostartBat(true), "autostart-off": () => runAutostartBat(false) },
  // Only start sharing once we hold the panel's port, so two hosts never fight over the same code.
  onListening: (url) => {
    console.log(`  Control center: ${url}`);
    if (!args.includes("--no-panel")) openWindow(url);
    keepAwake();
    pollOllama();
    setInterval(pollOllama, 3000);
    checkAutostart();
    setInterval(checkAutostart, 5000);
    connect();
  },
  onBusy: (url) => {
    console.log(`  Burrow is already running on this PC. Control center: ${url}`);
    if (!args.includes("--no-panel")) openWindow(url);
    setTimeout(() => process.exit(0), 500);
  },
});
