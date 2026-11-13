// The Agent in your own Chrome: the "Albatross Agent" extension (folder extension\ next to host\) connects here, on this PC only
// (ws://127.0.0.1:4749, only from a Chrome extension), and runs the same page reading, clicking and typing as the PC's hidden
// browser (browser.js) through Chrome's debugger on one tab of its own: the "Albatross Agent" tab group. Your logins are the ones in
// your Chrome; you see every step happen, and Chrome shows a bar while the Agent is attached ("Cancel" there stops it).
//
// Pairing: the app shows a 6-digit code (Settings → Tools → Work on your PC → My Chrome); typed into the extension it's swapped for a long key
// kept in the extension and in <LocalAppData>\Albatross\extension.json. Only a paired extension is listened to.
//
// Messages, as JSON:  PC → extension  { id, type: "cdp", method, params } | { id, type: "open", url } | { id, type: "control", action }
//                     extension → PC  { type: "hello", key, ua, version } | { type: "pair", code } | { id, ok, result | error }
//                                     { type: "event", method, params } | { type: "state", paused, tab }

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.ALBATROSS_EXT_PORT) || 4749;
const FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "extension.json");
const FOLDER = path.join(__dirname, "..", "extension");

const X = { ws: null, info: null, id: 0, pend: new Map(), loading: false, paused: false, tab: null, dialog: null, pair: null, note: () => {}, vp: { w: 1280, h: 800 } };
const keys = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")).keys || []; } catch { return []; } };
function saveKeys(list) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ keys: list }, null, 2)); }
const hash = (k) => crypto.createHash("sha256").update(String(k)).digest("hex");

let server = null;
function listen(note) {
  if (note) X.note = note;
  if (server) return;
  server = new WebSocket.Server({
    host: "127.0.0.1", port: PORT, maxPayload: 32 * 1024 * 1024,
    // websites can open connections to this PC too: only a Chrome extension is let in
    verifyClient: (info) => /^chrome-extension:\/\/[a-p]{32}$/.test(String(info.origin || "")),
  });
  server.on("error", (e) => { console.log("Extension link:", e.message); server = null; });
  server.on("connection", (ws, req) => {
    const origin = String(req.headers.origin || "");
    let ok = false;
    const out = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "pair") {
        if (!X.pair || Date.now() > X.pair.until || String(m.code || "").replace(/\D/g, "") !== X.pair.code) return out({ type: "paired", ok: false, error: "That code is wrong or too old. Make a new one in the app (Settings → Tools → Work on your PC → My Chrome)." });
        const key = crypto.randomBytes(24).toString("hex");
        saveKeys([...keys().filter((k) => k.origin !== origin), { hash: hash(key), origin, at: Date.now() }]);
        X.pair = null; X.note("Chrome extension paired");
        return out({ type: "paired", ok: true, key });
      }
      if (m.type === "hello") {
        if (!keys().some((k) => k.hash === hash(m.key) && k.origin === origin)) return out({ type: "unpaired" });
        ok = true;
        if (X.ws && X.ws !== ws) { try { X.ws.close(); } catch {} }
        X.ws = ws; X.info = { ua: String(m.ua || "").slice(0, 300), version: String(m.version || "").slice(0, 20), since: Date.now() };
        X.paused = !!m.paused; X.tab = m.tab || null;
        out({ type: "welcome" });
        return;
      }
      if (!ok) return;
      if (m.type === "state") { X.paused = !!m.paused; X.tab = m.tab || null; X.follow = !!m.follow; if (m.vp) X.vp = m.vp; return; }
      if (m.type === "event") {
        const p = m.params || {};
        if (m.method === "Page.frameStartedLoading") X.loading = true;
        else if (m.method === "Page.frameStoppedLoading" || m.method === "Page.loadEventFired") X.loading = false;
        else if (m.method === "Page.javascriptDialogOpening") X.dialog = { type: p.type, message: String(p.message || "").slice(0, 1000) };
        else if (m.method === "Page.javascriptDialogClosed") X.dialog = null;
        return;
      }
      if (m.id && X.pend.has(m.id)) { const q = X.pend.get(m.id); X.pend.delete(m.id); m.ok ? q.res(m.result || {}) : q.rej(new Error(m.error || "Chrome didn't do it")); }
    });
    ws.on("close", () => { if (X.ws === ws) { X.ws = null; X.loading = false; for (const q of X.pend.values()) q.rej(new Error("The Chrome extension disconnected")); X.pend.clear(); } });
  });
}

function call(o, ms = 25000) {
  return new Promise((res, rej) => {
    if (!X.ws || X.ws.readyState !== WebSocket.OPEN) return rej(new Error("Your Chrome isn't connected. Open Chrome on the PC (the Albatross Agent extension connects by itself), or switch the Agent to the PC browser."));
    if (X.paused && o.type !== "control") return rej(new Error("The Agent is paused in your Chrome (Albatross extension). Resume it there or in the app."));
    const id = ++X.id; X.pend.set(id, { res, rej });
    X.ws.send(JSON.stringify({ ...o, id }));
    setTimeout(() => { if (X.pend.has(id)) { X.pend.delete(id); rej(new Error((o.method || o.type) + " took too long in Chrome")); } }, ms);
  });
}

// what browser.js needs to run its page reading and clicking here instead of in the hidden browser
const driver = {
  dom: true,      // clicks and typing inside the page (browser.js domAct): a background tab doesn't take mouse and key events
  send: (method, params = {}) => call({ type: "cdp", method, params }),
  loading: () => X.loading,
  vp: () => X.vp,
  open: async (url) => { const r = await call({ type: "open", url }, 40000); if (r.vp) X.vp = r.vp; return r; },
};

function status() {
  return { connected: !!(X.ws && X.ws.readyState === WebSocket.OPEN), paired: keys().length > 0, paused: X.paused, tab: X.tab, follow: !!X.follow, info: X.info, dialog: X.dialog, folder: FOLDER, port: PORT, pairing: X.pair && Date.now() < X.pair.until ? { code: X.pair.code, until: X.pair.until } : null };
}

// Agent tab → Browser → My Chrome: everything the app can do with the extension
async function handle(j) {
  switch (j.action) {
    case "status": return status();
    case "pair": X.pair = { code: String(crypto.randomInt(0, 1e6)).padStart(6, "0"), until: Date.now() + 10 * 60e3 }; return status();
    case "forget": saveKeys([]); if (X.ws) { try { X.ws.send(JSON.stringify({ type: "control", action: "unpair" })); X.ws.close(); } catch {} } X.note("Chrome extension disconnected"); return status();
    case "pause": case "resume": case "closetab": case "detach": case "show":
      await call({ type: "control", action: j.action }, 8000); return status();
    case "folder": {
      if (process.platform === "win32") { const { spawn } = require("child_process"); const c = spawn("explorer.exe", [FOLDER], { detached: true, stdio: "ignore", windowsHide: true }); c.on("error", () => {}); c.unref(); }
      return { ...status(), opened: true };
    }
  }
  throw new Error("Unknown extension request");
}

module.exports = { listen, driver, status, handle };
