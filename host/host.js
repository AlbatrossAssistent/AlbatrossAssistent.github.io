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
const schedule = require("./schedule");
const monitor = require("./monitor");
const listRunner = require("./list");
const account = require("./account");
const PANEL_PORT = Number(process.env.BURROW_PANEL_PORT) || 4747;
// ---------- how busy the PC is (the PC page on the website) ----------
const cpuSnap = () => { let idle = 0, total = 0; for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; } return { idle, total }; };
let cpuPrev = cpuSnap(), cpuLast = null;
const coreSnap = () => os.cpus().map((c) => { const t = c.times; return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }; });
let corePrev = coreSnap(), coreLast = [];
setInterval(() => {
  const n = cpuSnap(), dt = n.total - cpuPrev.total; if (dt > 0) cpuLast = Math.round((1 - (n.idle - cpuPrev.idle) / dt) * 100); cpuPrev = n;
  const c = coreSnap(); coreLast = c.map((x, i) => { const d = x.total - (corePrev[i]?.total || 0); return d > 0 ? Math.round((1 - (x.idle - corePrev[i].idle) / d) * 100) : 0; }); corePrev = c;
}, 2000).unref();
// bytes sent and received by this PC, from `netstat -e` (fast; the detailed Windows counters take seconds), as a speed between two looks
let netPrev = null, netCache = { t: 0, v: null };
function netRates() {
  return new Promise((res) => {
    if (Date.now() - netCache.t < 1500) return res(netCache.v);
    execFile("netstat", ["-e"], { windowsHide: true, timeout: 3000 }, (err, out) => {
      let v = null;
      const m = !err && /Bytes\s+(\d+)\s+(\d+)/.exec(String(out));
      if (m) {
        const now = Date.now(), rx = Number(m[1]), tx = Number(m[2]);
        if (netPrev && now - netPrev.t > 300) { const dt = (now - netPrev.t) / 1000, wrap = (a, b) => (b >= a ? b - a : b + 2 ** 32 - a); v = { rx: wrap(netPrev.rx, rx) / dt, tx: wrap(netPrev.tx, tx) / dt }; }
        if (!netPrev || now - netPrev.t > 300) netPrev = { t: now, rx, tx };
      }
      netCache = { t: Date.now(), v: v || netCache.v }; res(netCache.v);
    });
  });
}
netRates().catch(() => {});
let gpuCache = { t: 0, v: null };
function gpuStats() {
  return new Promise((res) => {
    if (Date.now() - gpuCache.t < 1500) return res(gpuCache.v);
    execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 3000 }, (err, out) => {
      let v = null;
      if (!err) { const [name, util, used, total, temp, power] = String(out).trim().split(/\s*,\s*/); v = { name, util: Number(util), usedMB: Number(used), totalMB: Number(total), temp: Number(temp), power: Number(power) }; }
      gpuCache = { t: Date.now(), v }; res(v);
    });
  });
}
// ---------- is the PC locked? (Jarvis, the mouse and keyboard need an unlocked desktop) ----------
// While the lock screen or the sign-in screen is showing, Windows runs LogonUI.exe; it is not running on an unlocked desktop.
let lockCache = { t: 0, v: false };
function isLocked() {
  return new Promise((res) => {
    if (process.platform !== "win32") return res(false);
    if (Date.now() - lockCache.t < 3000) return res(lockCache.v);
    execFile("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"], { windowsHide: true, timeout: 4000 }, (err, out) => {
      const v = !err && /LogonUI\.exe/i.test(String(out));
      lockCache = { t: Date.now(), v: err ? lockCache.v : v }; res(lockCache.v);
    });
  });
}
// ---------- devices that talk to this PC with the code (kept on disk by drops.js, which also passes files between them) ----------
const drops = require("./drops");
function seeDevice(d) { const n = drops.see(d); if (n) note(`A device connected: ${n.name}`); }
// ---------- the PC's own power: what Wake-on-LAN needs to know, and shutting down ----------
const pcPower = {
  publicIp: "",
  mac() {
    // the wired card on the home network (the one Wake-on-LAN has to reach)
    const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).map((a) => ({ name, ...a })));
    const pick = all.find((a) => a.family === "IPv4" && !a.internal && /^(192\.168|10\.|172\.)/.test(a.address) && !/virtual|vethernet|vmware|hyper|loopback|wsl/i.test(a.name));
    return pick ? pick.mac.toUpperCase() : "";
  },
  async handle(method, p, body, note) {
    if (method === "GET" && p === "/pc/info") return [200, { mac: this.mac(), publicIp: this.publicIp, name: NAME, platform: process.platform }];
    if (method === "GET" && p === "/pc/stats") {
      let disk = null; try { const st = fs.statfsSync(process.platform === "win32" ? "C:\\" : "/"); disk = { freeGB: st.bavail * st.bsize / 1e9, totalGB: st.blocks * st.bsize / 1e9 }; } catch {}
      const cpus = os.cpus();
      return [200, { name: NAME, cpu: cpuLast, coresPct: coreLast, net: await netRates(), cpuName: (cpus[0]?.model || "").trim(), cores: cpus.length, memUsedGB: (os.totalmem() - os.freemem()) / 1e9, memTotalGB: os.totalmem() / 1e9, uptimeH: os.uptime() / 3600, gpu: await gpuStats(), disk, locked: await isLocked() }];
    }
    if (method === "GET" && p === "/pc/loadtimes") return [200, { times: loadTimes.all() }];
    if (method === "POST" && p === "/pc/loadtime") { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} return [200, { ok: loadTimes.record(j.model, j.secs) }]; }
    if (method === "GET" && p === "/pc/devices") return [200, { devices: drops.list() }];
    if (method === "POST" && p === "/pc/devices") { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} if (j.me) seeDevice(j.me); return [200, { devices: drops.list() }]; }
    if (method === "POST" && p === "/pc/forgetdevice") { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} return [200, { ok: drops.forget(j.id) }]; }
    if (p.startsWith("/pc/drop")) return drops.handle(method, p, body, note);
    if (p === "/pc/relayban") { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} return [200, method === "POST" ? setNoBan(j.noBan) : { noBan: !!state.noBan }]; }
    if (method === "GET" && p === "/pc/lock") return [200, { locked: await isLocked() }];
    if (method === "POST" && p === "/pc/shutdown") {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      const secs = Math.min(600, Math.max(15, Number(j.seconds) || 60));
      if (process.platform !== "win32") return [501, { error: "Shutting down is only set up for Windows." }];
      execFile("shutdown", ["/s", "/t", String(secs), "/c", "Albatross: shutting down, as asked from the website. Cancel it there or run: shutdown /a"], { windowsHide: true }, () => {});
      note(`Shutting down in ${secs} s, as asked from the website`);
      return [200, { ok: true, seconds: secs }];
    }
    if (method === "POST" && p === "/pc/sleep") {
      if (process.platform !== "win32") return [501, { error: "Sleep is only set up for Windows." }];
      note("Going to sleep, as asked from the website");
      setTimeout(() => schedule.sleepNow(), 1500);   // answer first, then sleep
      return [200, { ok: true }];
    }
    if (method === "GET" && p === "/pc/schedule") return [200, schedule.get()];
    // the Monitor: a picture or video full screen on this PC's screen (see monitor.js)
    if (p === "/pc/monitor") return monitor.handle(method, body, PANEL_PORT);
    // lists of requests that run here one after the other (see list.js)
    if (p === "/pc/list") { const [uid, b] = await account.fromBody(body); return listRunner.handle(method, b, { upstream, note, changed, activity: schedule.activity, uid }); }
    if (method === "POST" && p === "/pc/schedule") {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      return [200, await schedule.set(j)];
    }
    // the Hub: media and volume keys, the Start menu's programs, opening a website, locking (done on the desktop by desktop.js)
    if (p === "/pc/apps" || p === "/pc/media" || p === "/pc/launch" || p === "/pc/openurl" || p === "/pc/lockpc" || p === "/pc/volume" || p === "/pc/bright" || p === "/pc/playing") {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      if (method === "GET" && p === "/pc/apps") return [200, await pcDesk.call("apps")];
      // knobs and bars: GET reads, POST sets ({ level: 0..100, mute }); what is playing (the cover only when it changed)
      if (p === "/pc/volume") return [200, await pcDesk.call("volume", method === "POST" ? { level: j.level, mute: j.mute } : null)];
      if (p === "/pc/bright") return [200, await pcDesk.call("bright", method === "POST" ? { level: j.level } : null)];
      if (p === "/pc/playing") return [200, await pcDesk.call("playing", { coverKey: String(j.coverKey || "") })];
      if (method !== "POST") return [405, { error: "POST only" }];
      if (p === "/pc/media") return [200, await pcDesk.call("key", String(j.key || ""))];
      if (p === "/pc/launch") { const r = await pcDesk.call("launch", String(j.id || "")); note(`Hub: opened ${r.name}`); return [200, r]; }
      if (p === "/pc/openurl") { const r = await pcDesk.call("url", String(j.url || "")); note("Hub: opened a web page"); return [200, r]; }
      if (p === "/pc/lockpc") { const r = await pcDesk.call("lock"); note("Hub: locked the PC"); return [200, r]; }
    }
    if (p === "/pc/guest") {
      if (method === "GET") {
        return [200, { guestCode: stats.guestCode, guestLink: stats.guestLink, guestEnabled: stats.guestEnabled, guestConnection: stats.guestConnection, adminCode: stats.code, adminLink: stats.link, recaps: guestTool.listForOwner() }];
      }
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      if (j.action === "toggle") return [200, toggleGuest(j.enabled !== false)];
      if (j.action === "new-code" || j.action === "reset-guest-code") return [200, rollGuestCode()];
      if (j.action === "new-admin-code" || j.action === "reset-admin-code") return [200, rollAdminCode()];
      if (j.action === "describe") { const r = guestTool.describe(String(j.id || ""), String(j.model || ""), { ollama: OLLAMA, comfy, changed }); changed(); return r; }
      if (j.action === "delete-recap") { guestTool.deleteRecap(String(j.id || "")); changed(); return [200, { ok: true, recaps: guestTool.listForOwner() }]; }
      if (j.action === "clear-recaps") { guestTool.clearRecaps(); changed(); return [200, { ok: true, recaps: [] }]; }
      if (j.action === "file") return guestTool.readFileData(String(j.recapId || ""), String(j.fileId || ""));
      if (j.action === "open" || j.action === "reveal") {
        const f = guestTool.getFile(String(j.recapId || ""), String(j.fileId || ""));
        if (!f) return [404, { error: "File not found on this PC." }];
        if (j.action === "open") openLocalPath(f.path); else revealLocalPath(f.path);
        return [200, { ok: true }];
      }
      return [400, { error: "Unknown guest action" }];
    }
    if (method === "POST" && p === "/pc/cancel") {
      execFile("shutdown", ["/a"], { windowsHide: true }, () => {});
      note("Shutdown cancelled from the website");
      return [200, { ok: true }];
    }
    return [404, { error: "Unknown PC request" }];
  },
};
const jarvis = require("./jarvis");
const pcDesk = require("./pcdesk");
const codeTool = require("./code");
const chatStore = require("./chats");
const jobStore = require("./jobs");
const loadTimes = require("./loadtimes");
const browserTool = require("./browser");
setImmediate(() => browserTool.listenExtension((t) => note(t)));   // the Albatross Agent extension in your own Chrome connects here (browserext.js)
const agentTools = require("./agent");
const mailTools = require("./mail");
const docsTool = require("./docs");
const voiceTool = require("./voice");
const guestTool = require("./guest");
const agentHandle = (method, p, body) => (p.startsWith("/agent/mail/") ? mailTools.handle(method, p, body, note) : p.startsWith("/agent/voice/") ? voiceTool.handle(method, p, body, note) : p.startsWith("/agent/docs/") ? docsTool.handle(method, p, body, note, { ollama: OLLAMA }) : agentTools.handle(method, p, body, note));

const STATE_FILE = path.join(__dirname, "host-code.json");
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }

const args = process.argv.slice(2);
// Without a server argument, use the one from last time (the boot-time background task relies on this).
const SERVER = (args.find((a) => !a.startsWith("--")) || process.env.BURROW_SERVER || readState()?.server || "https://burrow-uu7e.onrender.com").replace(/\/+$/, "");
const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const NAME = process.env.BURROW_NAME || os.hostname();

if (!SERVER) {
  console.log("Usage: node host.js https://your-burrow-server.com [--new] [--new-guest] [--no-panel]");
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
function loadState(forceNew, forceNewGuest) {
  let st = readState();
  let dirty = !st;
  if (!st) st = {};
  const prevCode = st.code, prevKey = st.key, prevGuestCode = st.guestCode, prevGuestKey = st.guestKey;
  if (!st.code || forceNew) {
    let ac = newCode();
    while (ac === st.guestCode || ac === prevCode) ac = newCode();
    st.code = ac;
    st.secret = crypto.randomBytes(24).toString("hex");
    dirty = true;
  }
  if (!st.secret) { st.secret = crypto.randomBytes(24).toString("hex"); dirty = true; }
  if (!st.key || forceNew) {
    let ak = randomChars(8);
    while (ak === st.guestKey || ak === prevKey) ak = randomChars(8);
    st.key = ak;
    dirty = true;
  } // encryption key, the second half of the code
  if (!st.guestCode || forceNewGuest || st.guestCode === st.code) {
    let gc = newCode();
    while (gc === st.code || gc === prevGuestCode) gc = newCode();
    st.guestCode = gc;
    st.guestSecret = crypto.randomBytes(24).toString("hex");
    dirty = true;
  }
  if (!st.guestSecret) { st.guestSecret = crypto.randomBytes(24).toString("hex"); dirty = true; }
  if (!st.guestKey || forceNewGuest || st.guestKey === st.key) {
    let gk = randomChars(8);
    while (gk === st.key || gk === prevGuestKey) gk = randomChars(8);
    st.guestKey = gk;
    dirty = true;
  }
  if (typeof st.guestEnabled !== "boolean") { st.guestEnabled = true; dirty = true; }
  if (st.server !== SERVER) { st.server = SERVER; dirty = true; }
  if (dirty) fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return st;
}
// The full code: XXXX-XXXX finds this PC on the server, the second half is the key and is never sent anywhere.
const fullCode = (st) => `${st.code}-${st.key.slice(0, 4)}-${st.key.slice(4)}`;
const fullGuestCode = (st) => `${st.guestCode}-${st.guestKey.slice(0, 4)}-${st.guestKey.slice(4)}`;

// ---------- end-to-end encryption ----------
// Requests and answers are encrypted with AES-256-GCM using a key made from the second half of the code,
// so the Burrow server only passes along data it can't read or change. public/index.html does the same.
const deriveKeyPair = (key8, routeCode) => crypto.pbkdf2Sync(key8, "burrow-e2e-v1|" + routeCode, 600000, 32, "sha256");
const deriveKey = (st) => deriveKeyPair(st.key, st.code);
const deriveGuestKey = (st) => deriveKeyPair(st.guestKey, st.guestCode);
const deriveGuestSharedKey = (st) => deriveKeyPair(st.guestKey, st.code);
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
function openRequest(msg, isGuestSocket = false) {
  if (msg.method !== "POST" || msg.path !== "/e2e") throw new Error("This PC only accepts encrypted connections. Reload the page (Ctrl+F5) and enter the full 16-character code.");
  const rawBody = String(msg.body || "").trim();
  let r = null, guest = false, usedKey = aesKey;
  if (isGuestSocket) {
    if (state.guestEnabled === false) throw new Error("Guest mode is turned off on this PC.");
    try { r = JSON.parse(unseal(guestAesKey, rawBody, "req")); guest = true; usedKey = guestAesKey; }
    catch { throw new Error("Wrong guest code. Check the 16-character guest code."); }
  } else {
    try { r = JSON.parse(unseal(aesKey, rawBody, "req")); guest = false; usedKey = aesKey; }
    catch {
      if (state.guestEnabled !== false) {
        try { r = JSON.parse(unseal(guestSharedAesKey, rawBody, "req")); guest = true; usedKey = guestSharedAesKey; } catch {}
      }
      if (!r) throw new Error("Wrong code. Check the last 8 characters.");
    }
  }
  if (typeof r.id !== "string" || !(Math.abs(Date.now() - r.t) < 10 * 60e3)) throw new Error("Request expired. Check that the clock on your device is right.");
  if (seen.has(r.id)) throw new Error("Repeated request rejected");
  seen.set(r.id, Date.now());
  if (!guest) seeDevice(r.dev);
  return { rid: r.id, method: r.method, path: r.path, body: r.body, guest, key: usedKey };
}

let state = loadState(args.includes("--new"), args.includes("--new-guest"));
let aesKey = deriveKey(state);
let guestAesKey = deriveGuestKey(state);
let guestSharedAesKey = deriveGuestSharedKey(state);
const wsUrl = SERVER.replace(/^http/, "ws") + "/host";
const running = new Map(); // id -> AbortController
let retry = 1000, guestRetry = 1000, mainWs = null, guestWs = null;

// ---------- what the control center shows ----------
const stats = {
  name: NAME, server: SERVER, code: fullCode(state), startedAt: Date.now(),
  link: `${SERVER}/#code=${fullCode(state)}`, connection: "connecting", connectionSince: Date.now(),
  guestCode: fullGuestCode(state),
  guestLink: `${SERVER}/#code=${fullGuestCode(state)}`,
  guestEnabled: state.guestEnabled !== false,
  guestConnection: state.guestEnabled === false ? "off" : "connecting",
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
  // the image model only steps off the graphics card (it stays in ComfyUI's memory until its time frame runs out, see comfy.js)
  if (!comfy.isComfy(model) && (await comfy.release())) others.push("the image model (kept in memory)");
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
async function freeImageModels() { if (await comfy.release()) note("Moved the image model off the graphics card to make room for Jarvis"); }

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
    if (p === "/api/generate" && j.warm) { if (j.keepMinutes) comfy.setKeep(j.keepMinutes); comfy.warm(j.model, (t) => note(t)); return Response.json({ model: j.model, done: true, done_reason: "warming" }); }
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
  // Speculative decoding (a small "draft" model that Ollama 0.40 loads next to gemma4) crashes the load when the big model
  // already fills the graphics card ("0 MiB free" -> HTTP 500). Switched off unless a request says otherwise.
  if (j && !unload && (p === "/api/chat" || p === "/api/generate")) body = JSON.stringify({ ...j, options: { draft_num_predict: 0, ...(j.options || {}) } });
  const r = await fetch(OLLAMA + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body, signal });
  if (p === "/api/tags" && r.ok) {
    const t = await r.json();
    t.models = [...(t.models || []).filter((m) => !isCloud(m.name)), ...comfy.models()];
    return Response.json(t);
  }
  if (unload) comfy.free(); // "Free GPU memory" on the website frees ComfyUI's memory too
  return r;
}

// A free web host puts the server to sleep after 15 minutes without a request, and a sleeping PC or a changed network can
// kill the connection without the socket ever saying so: then this PC thinks it is online while nobody can reach it.
// So: touch the server over plain HTTPS every 4 minutes (that counts as a request), and ping through the socket.
setInterval(() => { fetch(SERVER + "/tools/status", { signal: AbortSignal.timeout(20000) }).catch(() => {}); }, 4 * 60e3).unref();

function openLocalPath(p) {
  if (process.platform !== "win32") return;
  const c = spawn("cmd", ["/c", "start", "", p], { detached: true, stdio: "ignore", windowsHide: true });
  c.on("error", () => {}); c.unref();
}
function revealLocalPath(p) {
  if (process.platform !== "win32") return;
  const c = spawn("explorer.exe", ["/select," + p], { detached: true, stdio: "ignore", windowsHide: true });
  c.on("error", () => {}); c.unref();
}

function updateGuestStats() {
  stats.guestCode = fullGuestCode(state);
  stats.guestLink = `${SERVER}/#code=${stats.guestCode}`;
  stats.guestEnabled = state.guestEnabled !== false;
  if (!stats.guestEnabled) stats.guestConnection = "off";
  changed();
}
// Settings → Connection: the relay blocks an internet address for 10 minutes after 30 requests to a code with no PC online (against
// guessing codes). Your own devices retrying while this PC is asleep or restarting can trip it. With noBan, the relay doesn't count or
// block requests to this PC's two codes; guessing other codes stays blocked.
function setNoBan(on) {
  state.noBan = !!on;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  for (const ws of [mainWs, guestWs]) if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "options", noBan: state.noBan }));
  note(state.noBan ? "Wrong-code lockout turned off for this PC's codes" : "Wrong-code lockout turned back on");
  return { noBan: state.noBan };
}
function toggleGuest(enabled) {
  state.guestEnabled = !!enabled;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  updateGuestStats();
  note(state.guestEnabled ? "Guest mode turned on" : "Guest mode turned off");
  if (!state.guestEnabled && guestWs) { try { guestWs.close(); } catch {} guestWs = null; }
  else if (state.guestEnabled && !guestWs) connectGuest();
  return { guestCode: stats.guestCode, guestLink: stats.guestLink, guestEnabled: stats.guestEnabled, guestConnection: stats.guestConnection };
}
function rollGuestCode() {
  state = loadState(false, true);
  guestAesKey = deriveGuestKey(state);
  guestSharedAesKey = deriveGuestSharedKey(state);
  updateGuestStats();
  note("Reset guest connection code");
  if (guestWs) { try { guestWs.close(); } catch {} guestWs = null; }
  if (state.guestEnabled !== false) connectGuest();
  return { guestCode: stats.guestCode, guestLink: stats.guestLink, guestEnabled: stats.guestEnabled, guestConnection: stats.guestConnection, adminCode: stats.code, adminLink: stats.link };
}
function rollAdminCode() {
  state = loadState(true, false);
  aesKey = deriveKey(state);
  guestSharedAesKey = deriveGuestSharedKey(state);
  stats.code = fullCode(state);
  stats.link = `${SERVER}/#code=${stats.code}`;
  changed();
  note("Reset admin connection code");
  const old = mainWs;
  mainWs = null;
  if (old) { try { old.close(); } catch {} }
  connect();
  return { code: stats.code, link: stats.link, adminCode: stats.code, adminLink: stats.link, guestCode: stats.guestCode, guestLink: stats.guestLink, guestEnabled: stats.guestEnabled, guestConnection: stats.guestConnection };
}

async function handleRelayRequest(send, ws, msg, isGuestSocket = false) {
  const { id } = msg;
  stats.totals.requests++;
  let req;
  try { req = openRequest(msg, isGuestSocket); }
  catch (e) {
    stats.totals.errors++;
    note("Rejected a request: " + e.message, "error");
    return send({ type: "fail", id, error: e.message });
  }
  const { rid, method, path: p, body, guest, key: replyKey } = req;
  // The answer goes back as encrypted, numbered frames ending with an "end" frame,
  // so the server can't change, reorder or cut off an answer without the browser noticing.
  // When authenticated with the guest code, every metadata frame carries g: 1 so the website knows it's in guest mode.
  let seq = 0;
  const reply = (frame) => send({ type: "chunk", id, data: seal(replyKey, JSON.stringify(frame && frame.k === "m" && guest ? { ...frame, g: 1 } : frame), `${rid}:${seq++}`) + "\n" });
  send({ type: "head", id, status: 200, contentType: "text/plain; charset=utf-8" });

  if (typeof p === "string" && p.startsWith("/guest/")) {
    let status = 500, out;
    try { [status, out] = guestTool.handleGuestEndpoint(method, p, body, { guest, ollama: OLLAMA, comfy, note, changed }); }
    catch (e) { out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }

  // Guest mode restriction: block all PC control, private files, mail, docs, browser, Jarvis, Beam, and owner chats.
  if (guest && typeof p === "string" && (p.startsWith("/pc/") || p.startsWith("/pcfiles/") || p.startsWith("/agent/") || p.startsWith("/browser/") || p.startsWith("/jarvis/") || p.startsWith("/files/") || p.startsWith("/chats/"))) {
    reply({ k: "m", s: 403, c: "application/json" });
    reply({ k: "d", d: JSON.stringify({ error: "Not available in guest mode: PC and private items are turned off." }) });
    reply({ k: "e" });
    return send({ type: "end", id });
  }

  // Files to and from this PC (see files.js), answered here instead of by Ollama.
  if (typeof p === "string" && p.startsWith("/pc/")) {
    let status = 500, out;
    try { [status, out] = await pcPower.handle(method, p, body, note); } catch (e) { status = e.status || 500; out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/code/")) {
    let status = 500, out;
    try {
      let codeBody = body, parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      if (guest) {
        if (p === "/code/projects") {
          status = 200; out = { folder: "", projects: [] };
        } else {
          const proj = String(parsed.project || "project");
          parsed.project = proj.startsWith("guest-") ? proj : "guest-" + proj;
          codeBody = JSON.stringify(parsed);
          [status, out] = codeTool.handle(method, p, codeBody, (t) => note("Guest " + t));
          if (status === 200 && p === "/code/write" && Array.isArray(out?.written)) {
            for (const w of out.written) {
              guestTool.recordPcFile(parsed.chatId || "_last", {
                kind: "code",
                name: `${out.project}/${w.path}`,
                path: path.join(out.folder, ...w.path.split("/")),
                rel: `Code/${out.project}/${w.path}`,
                size: w.size,
              });
            }
            changed();
          }
        }
      } else {
        [status, out] = codeTool.handle(method, p, codeBody, note);
      }
    } catch (e) { out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (typeof p === "string" && (p.startsWith("/pcfiles/") || p.startsWith("/agent/"))) {
    let status = 500, out;
    try { [status, out] = await agentHandle(method, p, body); } catch (e) { out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (p === "/browser/stream") {
    const ctrl = new AbortController(); running.set(id, ctrl);
    try {
      reply({ k: "m", s: 200, c: "application/x-ndjson" });
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      // a slow connection only gets the newest picture: skip frames while the socket still has a lot to send
      await browserTool.stream(j, (t) => reply({ k: "d", d: t }), ctrl.signal, () => ws.bufferedAmount > 1.5e6);
      reply({ k: "e" });
    } catch (e) { try { reply({ k: "d", d: JSON.stringify({ error: e.message }) + "\n" }); reply({ k: "e" }); } catch {} } finally { running.delete(id); }
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/browser/")) {
    let status = 500, out;
    try { [status, out] = await browserTool.handle(method, p, body, note); } catch (e) { out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (p === "/jobs/stream") {
    const ctrl = new AbortController(); running.set(id, ctrl);
    try {
      reply({ k: "m", s: 200, c: "application/x-ndjson" });
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      await jobStore.stream(j, (t) => reply({ k: "d", d: t }), ctrl.signal, guest ? "guest" : undefined);
      reply({ k: "e" });
    } catch {} finally { running.delete(id); }
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/jobs/")) {
    let status = 500, out;
    try {
      if (guest) {
        [status, out] = await jobStore.handle(method, p, body, {
          upstream,
          note: (t) => note("Guest: " + t),
          uid: "guest",
          onGuestDone: ({ chatId, model, body: jBody, content, kind, prompt, pcFile }) => {
            // a picture made for a guest is listed for the owner right away (with its file), even if the guest is gone
            if (kind === "image") {
              const f = pcFile ? guestTool.recordPcFile(chatId || "_last", pcFile) : null;
              guestTool.upsertRecap({ chatId: chatId || "guest-" + Date.now().toString(36), model, messages: [{ role: "user", content: prompt }, { role: "assistant", content: `[Generated picture: ${prompt}]`, genImage: true, prompt }], pcFiles: f ? [f] : [] }, { ollama: OLLAMA, comfy, note, changed });
              return;
            }
            // Fallback recap if the guest closed their tab while the job was running
            setTimeout(() => {
              const all = guestTool.listForOwner();
              if (chatId && all.some((x) => x.id === chatId && (x.recapBusy || Date.now() - x.updatedAt < 15000))) return;
              let jb = {}; try { jb = JSON.parse(jBody || "{}"); } catch {}
              const msgs = [...(jb.messages || []).filter((m) => m.role === "user" || m.role === "assistant"), { role: "assistant", content }];
              guestTool.upsertRecap({ chatId: chatId || "guest-job", model, messages: msgs, refreshRecap: false, aiSummary: false }, { ollama: OLLAMA, comfy, note, changed });
            }, 4000).unref();
          },
        });
      } else {
        const [uid, b] = await account.fromBody(body);
        [status, out] = await jobStore.handle(method, p, b, { upstream, note, uid });
      }
    } catch (e) { status = e.status || 500; out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    if (p === "/jobs/start") schedule.activity();
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/chats/")) {
    let status = 500, out;
    try { const [uid, b] = await account.fromBody(body); [status, out] = chatStore.handle(method, p, b, note, uid); } catch (e) { status = e.status || 500; out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/jarvis/")) {
    let status = 500, out;
    try { [status, out] = await jarvis.handle(method, p, body, note, freeImageModels); } catch (e) { out = { error: e.message }; }
    reply({ k: "m", s: status, c: "application/json" }); reply({ k: "d", d: JSON.stringify(out) }); reply({ k: "e" });
    if (method === "POST" && p === "/jarvis/ask") { note("Jarvis: a message from the website"); schedule.activity(); }
    return send({ type: "end", id });
  }
  if (method === "GET" && p === "/load") {
    reply({ k: "m", s: 200, c: "application/json" }); reply({ k: "d", d: JSON.stringify({ ...loadProgress(), guest: !!guest }) }); reply({ k: "e" });
    return send({ type: "end", id });
  }
  if (typeof p === "string" && p.startsWith("/files/")) schedule.activity();
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
  const desc = isChat ? describe(p, body) : null;
  if (desc && guest && desc.text) desc.text = "[Guest] " + desc.text;
  const entry = desc ? addLog({ ...desc, active: true, tokens: 0 }) : null;
  if (entry?.kind === "chat") stats.totals.messages++;
  if (isChat) schedule.activity();
  stats.active++;
  changed();

  const ctrl = new AbortController();
  running.set(id, ctrl);
  const started = Date.now();
  let tail = "", streamedText = "", madePcFile = null;
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
      if (guest && isChat) {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.message?.content) streamedText += o.message.content;
            else if (typeof o.response === "string") streamedText += o.response;
            if (o.pcFile) {
              madePcFile = guestTool.recordPcFile("_last", o.pcFile);
              changed();
            }
          } catch {}
        }
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
    // If a guest generated a picture or chat answer and closed the page before /guest/recap arrived, ensure a recap is still saved
    if (guest && entry?.kind === "chat" && !entry.error && (streamedText.trim() || madePcFile)) {
      let reqJson = {}; try { reqJson = JSON.parse(body || "{}"); } catch {}
      const cid = reqJson.chatId || "";
      if (cid || madePcFile) {
        setTimeout(() => {
          const all = guestTool.listForOwner();
          if (cid && all.some((x) => x.id === cid && (x.recapBusy || Date.now() - x.updatedAt < 15000))) return;
          const msgs = p === "/api/chat"
            ? [...(reqJson.messages || []).filter((m) => m.role === "user" || m.role === "assistant"), { role: "assistant", content: streamedText }]
            : [{ role: "user", content: String(reqJson.prompt || "") }, { role: "assistant", content: madePcFile ? `[Generated picture: ${reqJson.prompt || ""}]` : streamedText, genImage: !!madePcFile, prompt: reqJson.prompt }];
          guestTool.upsertRecap({ chatId: cid || "guest-" + Date.now().toString(36), model: reqJson.model, messages: msgs, pcFiles: madePcFile ? [madePcFile] : [], aiSummary: false }, { ollama: OLLAMA, comfy, note, changed });
        }, 3500).unref();
      }
    }
    if (p !== "/api/tags" && p !== "/api/ps") console.log(`  ${guest ? "[GUEST] " : ""}${method} ${p}  ${r.status}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
}

function connect() {
  const ws = new WebSocket(wsUrl, { maxPayload: 80 * 1024 * 1024 });
  mainWs = ws;
  const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  setConnection("connecting");
  let alive = true, tick = Date.now(), heart = 0;

  ws.on("open", () => {
    retry = 1000;
    send({ type: "register", code: state.code, secret: state.secret, name: NAME, noBan: !!state.noBan });
    heart = setInterval(() => {
      const now = Date.now(), gap = now - tick; tick = now;
      if (gap > 90e3) { note("The PC was asleep or offline, reconnecting…"); return ws.terminate(); }   // woke up: the old connection is dead
      if (!alive) { note("The server stopped answering, reconnecting…", "error"); return ws.terminate(); }
      alive = false;
      try { ws.ping(); } catch {}
    }, 20e3);
  });
  ws.on("pong", () => { alive = true; });
  ws.on("ping", () => { alive = true; });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "registered") {
      if (msg.ip) pcPower.publicIp = String(msg.ip);
      stats.code = fullCode(state);
      // After "#" the browser never sends it to any server, so the key stays private.
      stats.link = `${SERVER}/#code=${stats.code}`;
      setConnection("online");
      note("Connected to the server, sharing is on (end-to-end encrypted)");
      console.log("\n  ┌─────────────────────────────────────────┐");
      console.log(`  │   Guest code:  ${stats.guestCode}      │`);
      console.log("  │   Admin code:  ••••-••••-••••-••••      │");
      console.log("  └─────────────────────────────────────────┘");
      console.log(`  Guest link: ${stats.guestLink}`);
      console.log("  (Click Show in the Control Center to view or reset your Admin code.)");
      console.log("  Keep this window open. Ctrl+C to stop sharing.\n");
      return;
    }
    if (msg.type === "error") {
      if (msg.error === "code-in-use") {
        console.log("That code is taken on the server — making a new one.");
        note("Code was taken on the server, made a new one", "error");
        state = loadState(true);
        aesKey = deriveKey(state);
        guestSharedAesKey = deriveGuestSharedKey(state);
        send({ type: "register", code: state.code, secret: state.secret, name: NAME, noBan: !!state.noBan });
      } else { console.log("Server error:", msg.error); note("Server error: " + msg.error, "error"); }
      return;
    }
    if (msg.type === "abort") {
      running.get(msg.id)?.abort();
      running.delete(msg.id);
      return;
    }
    if (msg.type !== "req") return;
    await handleRelayRequest(send, ws, msg, false);
  });

  ws.on("close", () => {
    clearInterval(heart);
    for (const c of running.values()) c.abort();
    running.clear();
    if (mainWs !== ws) return;
    mainWs = null;
    if (stats.connection === "online") note("Lost connection to the server, reconnecting…", "error");
    setConnection("offline");
    console.log(`Disconnected from server. Reconnecting in ${retry / 1000}s…`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  });
  ws.on("error", (e) => console.log("Connection problem:", e.message));
}

// Separate relay registration for the Guest connection code (XXXX-XXXX-YYYY-YYYY), so guests use a completely different 16-char code.
function connectGuest() {
  if (state.guestEnabled === false || guestWs) return;
  const ws = new WebSocket(wsUrl, { maxPayload: 80 * 1024 * 1024 });
  guestWs = ws;
  const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  stats.guestConnection = "connecting"; changed();
  let alive = true, tick = Date.now(), heart = 0;

  ws.on("open", () => {
    guestRetry = 1000;
    send({ type: "register", code: state.guestCode, secret: state.guestSecret, name: NAME + " (Guest)", noBan: !!state.noBan });
    heart = setInterval(() => {
      const now = Date.now(), gap = now - tick; tick = now;
      if (gap > 90e3 || !alive) return ws.terminate();
      alive = false;
      try { ws.ping(); } catch {}
    }, 20e3);
  });
  ws.on("pong", () => { alive = true; });
  ws.on("ping", () => { alive = true; });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "registered") {
      stats.guestCode = fullGuestCode(state);
      stats.guestLink = `${SERVER}/#code=${stats.guestCode}`;
      stats.guestConnection = "online";
      changed();
      return;
    }
    if (msg.type === "error") {
      if (msg.error === "code-in-use") {
        state = loadState(false, true);
        guestAesKey = deriveGuestKey(state);
        guestSharedAesKey = deriveGuestSharedKey(state);
        updateGuestStats();
        send({ type: "register", code: state.guestCode, secret: state.guestSecret, name: NAME + " (Guest)", noBan: !!state.noBan });
      }
      return;
    }
    if (msg.type === "abort") {
      running.get(msg.id)?.abort();
      running.delete(msg.id);
      return;
    }
    if (msg.type !== "req") return;
    await handleRelayRequest(send, ws, msg, true);
  });

  ws.on("close", () => {
    clearInterval(heart);
    if (guestWs === ws) guestWs = null;
    if (state.guestEnabled === false) { stats.guestConnection = "off"; changed(); return; }
    stats.guestConnection = "offline"; changed();
    setTimeout(() => { if (state.guestEnabled !== false && !guestWs) connectGuest(); }, guestRetry);
    guestRetry = Math.min(guestRetry * 2, 30000);
  });
  ws.on("error", () => {});
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
  port: PANEL_PORT,
  monitor,
  getState: () => ({ ...stats, files: files.state(), guestRecaps: guestTool.listForOwner(), now: Date.now() }),
  files,
  guestFile: (recapId, fileId) => guestTool.getFile(recapId, fileId),
  code: (method, p, body) => codeTool.handle(method, p, body, note),
  chats: async (method, p, body) => { const [uid, b] = await account.fromBody(body); return chatStore.handle(method, p, b, note, uid); },
  agent: (method, p, body) => agentHandle(method, p, body),
  browser: (method, p, body) => browserTool.handle(method, p, body, note),
  browserStream: (body, write, signal, busy) => { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} return browserTool.stream(j, write, signal, busy); },
  jobs: async (method, p, body) => { const [uid, b] = await account.fromBody(body); return jobStore.handle(method, p, b, { upstream, note, uid }); },
  jobsStream: (body, write, signal) => { let j = {}; try { j = JSON.parse(body || "{}"); } catch {} return jobStore.stream(j, write, signal); },
  // the website on this PC talks to Ollama directly, so it asks here to watch a model load
  load: (model) => { if (model && !isCloud(model)) watchLoad(model); return loadProgress(); },
  jarvis: (method, p, body) => p.startsWith("/pc/") ? pcPower.handle(method, p.split("?")[0], body, note) : jarvis.handle(method, p, body, note, freeImageModels),
  proxy: (method, p, body, signal) => {
    if (!ALLOWED.has(`${method} ${p}`)) return Response.json({ error: "Not allowed" }, { status: 403 });
    if (method === "POST" && (p === "/api/chat" || p === "/api/generate")) {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      if (j.prompt || j.messages) note(`This PC's website: ${j.model}${comfy.isComfy(j.model) ? " (image)" : ""}`);
    }
    return upstream(method, p, body, signal);
  },
  actions: {
    "idle-tick": () => schedule.idleTick(),
    "remove-outbox": (b) => { const r = files.removeFromOutbox(b.name); changed(); return r; },
    "free-gpu": freeGpu,
    "autostart-on": () => runAutostartBat(true),
    "autostart-off": () => runAutostartBat(false),
    "guest-toggle": (b) => toggleGuest(b.enabled !== false),
    "guest-new-code": () => rollGuestCode(),
    "admin-new-code": () => rollAdminCode(),
    "guest-delete-recap": (b) => { guestTool.deleteRecap(String(b.id || "")); changed(); return { ok: true }; },
    "guest-clear-recaps": () => { guestTool.clearRecaps(); changed(); return { ok: true }; },
    "guest-open-file": (b) => { const f = guestTool.getFile(String(b.recapId || ""), String(b.fileId || "")); if (f) openLocalPath(f.path); return { ok: !!f }; },
    "guest-reveal-file": (b) => { const f = guestTool.getFile(String(b.recapId || ""), String(b.fileId || "")); if (f) revealLocalPath(f.path); return { ok: !!f }; },
    "restart": () => {
      setTimeout(() => {
        try { panel.close && panel.close(); } catch {}
        try { if (mainWs) mainWs.close(); } catch {}
        try { if (guestWs) guestWs.close(); } catch {}
        const entry = stats.background ? path.join(__dirname, "background.js") : __filename;
        const child = spawn(process.execPath, [entry, ...args.filter((a) => a !== "--restarted")], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
        setTimeout(() => process.exit(0), 200);
      }, 150);
      return { ok: true };
    },
  },
  // Only start sharing once we hold the panel's port, so two hosts never fight over the same code.
  onListening: (url) => {
    console.log(`  Control center: ${url}`);
    if (!args.includes("--no-panel")) openWindow(url);
    keepAwake();
    schedule.start(note);
    monitor.setNote(note);
    comfy.retireOutdated(note);
    pollOllama();
    setInterval(pollOllama, 3000);
    checkAutostart();
    setInterval(checkAutostart, 5000);
    connect();
    connectGuest();
  },
  onBusy: async (url) => {
    let needsRestart = args.includes("--restart") || args.includes("--new") || args.includes("--new-guest");
    if (!needsRestart) {
      try {
        const r = await fetch(`http://127.0.0.1:${PANEL_PORT}/pc/guest`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) needsRestart = true;
        else { const j = await r.json(); if (!j || !j.guestCode) needsRestart = true; }
      } catch { needsRestart = true; }
    }
    if (needsRestart && process.platform === "win32" && !args.includes("--restarted")) {
      console.log("  Updating running Burrow host with new version…");
      execFile("schtasks", ["/End", "/TN", TASK], { windowsHide: true }, () => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -LocalPort ${PANEL_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { windowsHide: true }, () => {
          execFile("schtasks", ["/Run", "/TN", TASK], { windowsHide: true }, (err) => {
            if (err) {
              const child = spawn(process.execPath, [__filename, ...args, "--restarted"], { detached: true, stdio: "ignore", windowsHide: true });
              child.on("error", () => {});
              child.unref();
            }
            setTimeout(() => process.exit(0), 500);
          });
        });
      });
      return;
    }
    console.log(`  Burrow is already running on this PC. Control center: ${url}`);
    if (!args.includes("--no-panel")) openWindow(url);
    setTimeout(() => process.exit(0), 500);
  },
});
