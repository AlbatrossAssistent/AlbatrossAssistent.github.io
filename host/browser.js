// A real browser for the website: Chrome runs on this PC (without a window), its screen is streamed to the device as pictures, and the
// device's clicks, taps, scrolling and typing are sent back. So every site works like in Chrome, logins stay in a profile on this PC,
// and a phone can use it from anywhere with the code. Only devices with the full code (or the website on this PC) reach it.
//
// Talks to Chrome over its DevTools protocol on 127.0.0.1. Profile: %LOCALAPPDATA%\Albatross\Browser. Downloads: Downloads\Albatross\Browser downloads.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PROFILE = process.env.ALBATROSS_BROWSER_PROFILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "Browser");
const DOWNLOADS = path.join(path.resolve(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross")), "Browser downloads");
const PORT = Number(process.env.ALBATROSS_BROWSER_PORT) || 9339;
const IDLE_MS = 15 * 60e3;   // nobody watching for this long: Chrome is closed to free memory

function chromePath() {
  const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const c = [...pf.map((d) => path.join(d, "Google", "Chrome", "Application", "chrome.exe")), ...pf.map((d) => path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"))];
  return c.find((x) => fs.existsSync(x)) || "";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = {
  proc: null, ws: null, id: 0, pend: new Map(), sessions: new Map(), active: null, starting: null,
  frame: null, seq: 0, tabs: [], nav: { url: "", title: "", back: false, fwd: false }, loading: false, dialog: null, download: "",
  vp: { w: 1280, h: 800, dpr: 1, mobile: false }, ua: "", watchers: 0, lastUse: Date.now(), waiters: [], quality: 60, note: () => {},
};
const wake = () => { for (const w of B.waiters.splice(0)) w(); };
function send(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    if (!B.ws || B.ws.readyState !== WebSocket.OPEN) return rej(new Error("The browser isn't running."));
    const id = ++B.id; B.pend.set(id, { res, rej });
    B.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => { if (B.pend.has(id)) { B.pend.delete(id); rej(new Error(method + " took too long")); } }, 20000);
  });
}
const cur = () => B.sessions.get(B.active);

async function start() {
  if (B.ws && B.ws.readyState === WebSocket.OPEN && B.active) return;
  if (B.starting) return B.starting;
  B.starting = (async () => {
    const exe = chromePath(); if (!exe) throw new Error("Chrome or Edge isn't installed on this PC.");
    fs.mkdirSync(PROFILE, { recursive: true }); fs.mkdirSync(DOWNLOADS, { recursive: true });
    noFormMemory();
    const version = () => fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
    let ver = await version();
    if (!ver) {
      B.proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${PROFILE}`,
        "--no-first-run", "--no-default-browser-check", "--mute-audio", "--hide-scrollbars", "--disable-features=Translate", "https://www.google.com/"], { stdio: "ignore", windowsHide: true });
      B.proc.on("exit", () => { B.proc = null; });
      for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await version(); }
      if (!ver) throw new Error("The browser didn't start.");
    }
    // sites treat "HeadlessChrome" differently: look like the normal Chrome it is
    B.ua = String(ver["User-Agent"] || "").replace("HeadlessChrome", "Chrome");
    B.ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
    await new Promise((res, rej) => { B.ws.once("open", res); B.ws.once("error", rej); });
    B.ws.on("message", onMessage);
    // Chrome is gone (closed, crashed, cleared): its sessions went with it, the private one too, so their ids are forgotten
    // (a new start would otherwise open its first tab in a private session that no longer exists)
    B.ws.on("close", () => { B.ws = null; B.sessions.clear(); B.active = null; B.priv = null; B.defCtx = null; B.privOld = null; for (const p of B.pend.values()) p.rej(new Error("The browser closed")); B.pend.clear(); wake(); });
    await send("Target.setDiscoverTargets", { discover: true });
    await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true }).catch(() => {});
    await refreshTabs();
    if (B.tabs.length) await activate(B.tabs[0].id); else await newTab("https://www.google.com/");
  })().finally(() => { B.starting = null; });
  return B.starting;
}
async function stop() {
  const proc = B.proc;
  try { await send("Browser.close"); } catch {}
  for (let i = 0; i < 40 && B.ws; i++) await sleep(150);                                   // the connection ends when Chrome has closed
  for (let i = 0; i < 40 && proc && proc.exitCode === null && !proc.killed && B.proc; i++) await sleep(150);
  try { if (B.proc && B.proc.exitCode === null) B.proc.kill(); } catch {}
  B.active = null; B.frame = null; wake();
}

function onMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.id && B.pend.has(m.id)) { const p = B.pend.get(m.id); B.pend.delete(m.id); return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result || {}); }
  const sid = m.sessionId, p = m.params || {}, mine = sid && sid === cur();
  switch (m.method) {
    case "Page.screencastFrame":
      send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
      if (mine) { B.frame = { data: p.data, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight }; B.seq++; wake(); }
      break;
    case "Target.targetCreated":
      if (p.targetInfo.type === "page") { refreshTabs().then(() => { if (p.targetInfo.openerId) activate(p.targetInfo.targetId).catch(() => {}); }); }
      break;
    case "Target.targetDestroyed":
      B.sessions.delete(p.targetId);
      refreshTabs().then(async () => { if (B.active === p.targetId) { B.active = null; if (B.tabs.length) await activate(B.tabs[B.tabs.length - 1].id); else await newTab("https://www.google.com/"); } }).catch(() => {});
      break;
    case "Target.targetInfoChanged": {
      const t = B.tabs.find((x) => x.id === p.targetInfo.targetId);
      if (t) { t.title = p.targetInfo.title; t.url = p.targetInfo.url; }
      if (p.targetInfo.targetId === B.active) { B.nav.url = p.targetInfo.url; B.nav.title = p.targetInfo.title; updateNav(); }
      wake(); break;
    }
    case "Target.detachedFromTarget":
      for (const [k, v] of B.sessions) if (v === p.sessionId) B.sessions.delete(k);
      break;
    case "Page.frameStartedLoading": if (mine) { B.loading = true; wake(); } break;
    case "Page.frameStoppedLoading": case "Page.loadEventFired": if (mine) { B.loading = false; updateNav(); wake(); } break;
    case "Page.frameNavigated": if (mine && !p.frame.parentId) updateNav(); break;
    case "Page.javascriptDialogOpening": if (mine) { B.dialog = { type: p.type, message: String(p.message || "").slice(0, 1000), prompt: p.defaultPrompt || "" }; wake(); } break;
    case "Page.javascriptDialogClosed": if (mine) { B.dialog = null; wake(); } break;
    case "Browser.downloadWillBegin": B.download = "Downloading " + p.suggestedFilename + "…"; wake(); break;
    case "Browser.downloadProgress":
      if (p.state === "completed") { B.download = "Downloaded to PC files → Browser downloads"; B.note("Browser: a download finished"); wake(); }
      else if (p.state === "canceled") { B.download = "Download cancelled"; wake(); }
      break;
  }
}
async function refreshTabs() {
  const t = (await send("Target.getTargets")).targetInfos || [];
  const pages = t.filter((x) => x.type === "page" && !/^devtools:/.test(x.url));
  if (!B.defCtx) { const d = pages.find((x) => x.browserContextId); if (d) B.defCtx = d.browserContextId; }
  B.tabs = pages.filter((x) => (B.priv ? x.browserContextId === B.priv : x.browserContextId !== B.privOld && (!B.defCtx || x.browserContextId === B.defCtx))).map((x) => ({ id: x.targetId, title: x.title, url: x.url }));
  wake();
}
async function updateNav() {
  const s = cur(); if (!s) return;
  try {
    const h = await send("Page.getNavigationHistory", {}, s), e = h.entries[h.currentIndex] || {};
    B.nav = { url: e.url || B.nav.url, title: e.title || B.nav.title, back: h.currentIndex > 0, fwd: h.currentIndex < h.entries.length - 1 };
    wake();
  } catch {}
}
async function applyViewport(s) {
  const v = B.vp;
  await send("Emulation.setDeviceMetricsOverride", { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.mobile }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: v.mobile, maxTouchPoints: v.mobile ? 5 : 0 }, s).catch(() => {});
  const ver = (/Chrome\/([\d.]+)/.exec(B.ua) || [])[1] || "130.0.0.0";
  const ua = v.mobile ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36` : B.ua;
  if (ua) await send("Emulation.setUserAgentOverride", { userAgent: ua }, s).catch(() => {});
}
async function startCast(s) {
  await send("Page.stopScreencast", {}, s).catch(() => {});
  await send("Page.startScreencast", { format: "jpeg", quality: B.quality, maxWidth: Math.round(B.vp.w * B.vp.dpr), maxHeight: Math.round(B.vp.h * B.vp.dpr), everyNthFrame: 1 }, s);
}
async function activate(id) {
  const old = cur(); if (old && B.active !== id) await send("Page.stopScreencast", {}, old).catch(() => {});
  B.active = id;
  let s = B.sessions.get(id);
  if (!s) { s = (await send("Target.attachToTarget", { targetId: id, flatten: true })).sessionId; B.sessions.set(id, s); await send("Page.enable", {}, s); }
  await send("Target.activateTarget", { targetId: id }).catch(() => {});
  B.dialog = null;
  await applyViewport(s); await startCast(s); await updateNav();
  const t = B.tabs.find((x) => x.id === id); if (t) { B.nav.title = t.title; }
  wake();
}
async function newTab(url) {
  const { targetId } = await send("Target.createTarget", { url: url || "https://www.google.com/", ...(B.priv ? { browserContextId: B.priv } : {}) });
  await refreshTabs(); await activate(targetId);
}
function fixUrl(u) {
  u = String(u || "").trim(); if (!u) return "";
  if (/^(https?|about|data|file|chrome):/i.test(u)) return /^(file|chrome):/i.test(u) ? "" : u;
  if (!/\s/.test(u) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(u)) return "https://" + u;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(u)) return "http://" + u;
  return "https://www.google.com/search?q=" + encodeURIComponent(u);
}
const KEYS = { Enter: [13, "Enter", "\r"], Backspace: [8, "Backspace"], Tab: [9, "Tab"], Escape: [27, "Escape"], Delete: [46, "Delete"], ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"], F5: [116, "F5"] };
async function input(j) {
  const s = cur(); if (!s) throw new Error("The browser isn't open.");
  const mods = (j.alt ? 1 : 0) | (j.ctrl ? 2 : 0) | (j.meta ? 4 : 0) | (j.shift ? 8 : 0);
  const x = Number(j.x) || 0, y = Number(j.y) || 0, button = ["left", "right", "middle"].includes(j.button) ? j.button : "left";
  const mouse = (type, extra) => send("Input.dispatchMouseEvent", { type, x, y, modifiers: mods, ...extra }, s);
  switch (j.t) {
    case "click": await mouse("mousePressed", { button, clickCount: j.count || 1 }); await mouse("mouseReleased", { button, clickCount: j.count || 1 }); break;
    case "down": await mouse("mousePressed", { button, clickCount: j.count || 1 }); break;
    case "up": await mouse("mouseReleased", { button, clickCount: j.count || 1 }); break;
    case "move": await mouse("mouseMoved", { button: j.drag ? "left" : "none", buttons: j.drag ? 1 : 0 }); break;
    case "wheel": await mouse("mouseWheel", { deltaX: Number(j.dx) || 0, deltaY: Number(j.dy) || 0 }); break;
    case "text": if (j.text) await send("Input.insertText", { text: String(j.text).slice(0, 5000) }, s); break;
    case "key": {
      let k = KEYS[j.key];
      if (!k && /^[a-z0-9]$/i.test(j.key || "")) { const c = j.key.toUpperCase(); k = [c.charCodeAt(0), /\d/.test(c) ? "Digit" + c : "Key" + c]; }
      if (!k) break;
      const [vk, code, text] = k;
      await send("Input.dispatchKeyEvent", { type: text && !mods ? "keyDown" : "rawKeyDown", key: j.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, ...(text && !mods ? { text, unmodifiedText: text } : {}) }, s);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: j.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods }, s);
      break;
    }
  }
}
// ---------- for the AI: read the page as text with numbered things to click or type into, and act on a number ----------
const READ_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  document.querySelectorAll("[data-alb]").forEach((e) => e.removeAttribute("data-alb"));
  const els = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=true],summary')].filter(vis).slice(0, 80);
  const elements = els.map((e, i) => {
    e.setAttribute("data-alb", String(i + 1));
    const label = (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || e.alt || e.name || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    return { n: i + 1, kind: e.tagName.toLowerCase() === "a" ? "link" : e.tagName.toLowerCase() === "input" ? "input:" + (e.type || "text") : e.tagName.toLowerCase(), label, href: e.href ? String(e.href).slice(0, 120) : undefined };
  });
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000), elements, scrolled: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, windowHeight: innerHeight };
})()`;
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cur());
  if (r.exceptionDetails) throw new Error("The page didn't answer: " + (r.exceptionDetails.text || "error"));
  return r.result ? r.result.value : null;
}
async function settle(ms = 10000) {   // wait until the page has loaded (or give up quietly)
  const end = Date.now() + ms; await sleep(400);
  while (B.loading && Date.now() < end) await sleep(200);
  await sleep(300);
}
async function readPage() { return evalJs(READ_JS); }
async function act(j) {
  if (j.action === "scroll") { await input({ t: "wheel", x: Math.round(B.vp.w / 2), y: Math.round(B.vp.h / 2), dy: (j.direction === "up" ? -0.8 : 0.8) * B.vp.h }); await sleep(500); return { ok: true }; }
  const n = Math.round(Number(j.n));
  const r = await evalJs(`(() => { const e = document.querySelector('[data-alb="${n}"]'); if (!e) return null; e.scrollIntoView({ block: "center", inline: "center" }); const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), password: e.type === "password", label: (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || "").trim().slice(0, 80) }; })()`);
  if (!r) throw new Error(`There is no number ${n} on the page any more. Read the page again.`);
  if (j.action === "type" && r.password) throw new Error("Passwords are never typed by the AI. Ask the user to type it in the Browser themselves.");
  await sleep(150);
  await input({ t: "click", x: r.x, y: r.y });
  if (j.action === "type") {
    await sleep(120);
    if (j.clear !== false) { await input({ t: "key", key: "a", ctrl: true }); await input({ t: "key", key: "Backspace" }); }
    await input({ t: "text", text: String(j.text || "") });
    if (j.submit) await input({ t: "key", key: "Enter" });
  }
  await settle(6000);
  return { ok: true, on: r.label };
}
// Private: a separate session like an incognito window. Nothing it sees is written to the profile (no history, cookies, logins),
// and switching it off throws the whole session away.
async function setPrivate(on) {
  if (on && !B.priv) {
    B.priv = (await send("Target.createBrowserContext", { disposeOnDetach: false })).browserContextId;
    await newTab("https://www.google.com/");
  } else if (!on && B.priv) {
    const ctx = B.priv; B.priv = null; B.privOld = ctx;
    const s = cur(); if (s) await send("Page.stopScreencast", {}, s).catch(() => {});
    B.active = null;
    await send("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {});
    await refreshTabs();
    if (B.tabs.length) await activate(B.tabs[B.tabs.length - 1].id); else await newTab("https://www.google.com/");
  }
}
// Clear the normal history: Chrome is closed, its history files are deleted (logins and cookies stay), and it starts again when used.
// Chrome's own memory of what was typed into fields (it suggests old entries below search boxes): switched off in the profile's settings.
// Only written while Chrome is closed, since Chrome rewrites the file itself while it runs.
function noFormMemory() {
  try {
    if (B.ws) return;
    const f = path.join(PROFILE, "Default", "Preferences");
    let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    j.autofill = { ...(j.autofill || {}), enabled: false, profile_enabled: false, credit_card_enabled: false };
    j.search = { ...(j.search || {}), suggest_enabled: false };
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j));
  } catch {}
}
// Search sites keep their own list of recent searches in the site's storage (not in Chrome's history). Wiped for the big ones; cookies stay, so logins stay.
const SEARCH_SITES = ["https://www.google.com", "https://google.com", "https://www.google.de", "https://www.google.at", "https://www.google.ch", "https://www.bing.com", "https://duckduckgo.com", "https://www.youtube.com", "https://m.youtube.com", "https://search.yahoo.com", "https://www.ecosia.org"];
async function clearHistory() {
  await stop();
  for (let i = 0; i < 40 && B.proc; i++) await sleep(250);
  await sleep(500);
  const dir = path.join(PROFILE, "Default"), gone = [];
  for (const f of ["History", "History-journal", "Visited Links", "Top Sites", "Top Sites-journal", "Shortcuts", "Shortcuts-journal", "Network Action Predictor", "Network Action Predictor-journal", "Web Data", "Web Data-journal"]) {
    try { fs.unlinkSync(path.join(dir, f)); gone.push(f); } catch {}
  }
  // what sites remember for themselves (Google's recent searches, YouTube's watch suggestions...) lives in their site storage:
  // all of it is removed. Cookies stay, so you stay signed in.
  for (const d of ["Local Storage", "Session Storage", "IndexedDB", "Service Worker", "Cache", "Code Cache", "GPUCache", "Shared Dictionary", "WebStorage", "databases"]) {
    try { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); gone.push(d); } catch {}
  }
  B.priv = null; B.defCtx = null; B.privOld = null;
  noFormMemory();
  return gone.length;
}
function state() {
  const at = B.tabs.find((t) => t.id === B.active);
  return { private: !!B.priv, url: B.nav.url, title: (at && at.title) || B.nav.title, back: B.nav.back, fwd: B.nav.fwd, loading: B.loading, dialog: B.dialog, download: B.download, active: B.active, tabs: B.tabs.map((t) => ({ id: t.id, title: t.title || t.url, url: t.url })) };
}

// The live picture: a line per new frame (only the newest, never a backlog) plus the address bar, tabs and dialogs when they change.
async function stream(j, write, signal, busy) {
  await start();
  B.watchers++; B.lastUse = Date.now();
  const fps = Math.max(1, Math.min(30, Number(j.fps) || 10)), gap = 1000 / fps;
  let seq = -1, st = "", last = 0;
  try {
    for (;;) {
      if (signal && signal.aborted) return;
      B.lastUse = Date.now();
      if (Date.now() - (B.tabsAt || 0) > 2000) { B.tabsAt = Date.now(); refreshTabs().catch(() => {}); }   // titles change without navigating
      const s = JSON.stringify(state()), frameNew = B.frame && B.seq !== seq, now = Date.now();
      if ((frameNew && now - last >= gap && !(busy && busy())) || s !== st) {
        const o = {};
        if (frameNew && now - last >= gap && !(busy && busy())) { o.img = B.frame.data; o.w = B.frame.w; o.h = B.frame.h; seq = B.seq; last = now; }
        if (s !== st) { o.st = JSON.parse(s); st = s; }
        write(JSON.stringify(o) + "\n");
        continue;
      }
      if (!B.ws) return write(JSON.stringify({ closed: true }) + "\n");
      await new Promise((res) => {
        const wait = frameNew ? Math.max(20, gap - (now - last)) : 2500;
        const t = setTimeout(() => { res(); if (!frameNew && Date.now() - (B.kaAt || 0) > 15000) { B.kaAt = Date.now(); write(JSON.stringify({ ka: 1 }) + "\n"); } }, wait);
        const w = () => { clearTimeout(t); res(); };
        B.waiters.push(w);
        if (signal) signal.addEventListener("abort", w, { once: true });
      });
    }
  } finally { B.watchers--; }
}
setInterval(() => { if (B.ws && B.watchers <= 0 && Date.now() - B.lastUse > IDLE_MS) stop(); }, 60e3).unref();

async function handle(method, p, body, note) {
  B.note = note || B.note;
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  try {
    if (p === "/browser/start" || p === "/browser/viewport") {
      if (j.w) B.vp = { w: Math.max(240, Math.min(2560, Math.round(j.w))), h: Math.max(240, Math.min(2000, Math.round(j.h))), dpr: Math.max(1, Math.min(2, Number(j.dpr) || 1)), mobile: !!j.mobile };
      if (j.quality) B.quality = Math.max(30, Math.min(90, Math.round(j.quality)));
      await start();
      const s = cur(); if (s && p === "/browser/viewport") { await applyViewport(s); await startCast(s); }
      return [200, state()];
    }
    if (p === "/browser/state") return [200, B.ws ? state() : { closed: true }];
    if (p === "/browser/stop") { await stop(); return [200, { closed: true }]; }
    if (p === "/browser/clearhistory") { const n = await clearHistory(); B.note("Browser: history cleared"); return [200, { cleared: n }]; }
    await start();
    if (p === "/browser/input") { await input(j); return [200, { ok: true }]; }
    if (p === "/browser/nav") {
      const s = cur();
      if (j.action === "back" || j.action === "forward") { const h = await send("Page.getNavigationHistory", {}, s), e = h.entries[h.currentIndex + (j.action === "back" ? -1 : 1)]; if (e) await send("Page.navigateToHistoryEntry", { entryId: e.id }, s); }
      else if (j.action === "reload") await send("Page.reload", {}, s);
      else if (j.action === "stop") await send("Page.stopLoading", {}, s);
      else { const u = fixUrl(j.url); if (!u) return [400, { error: "That address can't be opened here." }]; await send("Page.navigate", { url: u }, s); }
      return [200, state()];
    }
    if (p === "/browser/tab") {
      if (j.action === "new") await newTab(fixUrl(j.url) || "https://www.google.com/");
      else if (j.action === "close" && j.id) await send("Target.closeTarget", { targetId: j.id });
      else if (j.action === "switch" && j.id) await activate(j.id);
      return [200, state()];
    }
    if (p === "/browser/private") { await setPrivate(!!j.on); return [200, state()]; }
    if (p === "/browser/open") { const u = fixUrl(j.url); if (!u) return [400, { error: "That address can't be opened here." }]; await send("Page.navigate", { url: u }, cur()); await settle(); return [200, await readPage()]; }
    if (p === "/browser/read") return [200, await readPage()];
    if (p === "/browser/act") { const r = await act(j); return [200, { ...r, page: await readPage() }]; }
    if (p === "/browser/dialog") { const s = cur(); await send("Page.handleJavaScriptDialog", { accept: !!j.accept, promptText: j.text != null ? String(j.text) : undefined }, s); B.dialog = null; wake(); return [200, state()]; }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown browser request" }];
}

module.exports = { handle, stream };
