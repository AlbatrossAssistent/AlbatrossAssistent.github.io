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
const ext = require("./browserext");
const agentFiles = require("./agent");

const PROFILE = process.env.ALBATROSS_BROWSER_PROFILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "Browser");
const DOWNLOADS = path.join(path.resolve(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross")), "Browser downloads");
const PORT = Number(process.env.ALBATROSS_BROWSER_PORT) || 9339;
const IDLE_MS = 15 * 60e3;   // nobody watching for this long: Chrome is closed to free memory

const MIME_EXT = { "text/plain": ".txt", "text/markdown": ".md", "application/json": ".json", "text/csv": ".csv", "text/html": ".html", "text/css": ".css", "text/javascript": ".js", "application/javascript": ".js", "application/pdf": ".pdf", "application/zip": ".zip", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4" };
const EXT_MIME = { txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", py: "text/x-python", xml: "text/xml", pdf: "application/pdf", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const mimeOfName = (n) => EXT_MIME[path.extname(String(n || "")).slice(1).toLowerCase()] || "application/octet-stream";
function safeFileName(n, mime = "") {
  let base = path.basename(String(n || "").split(/[?#]/)[0]).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").replace(/[. ]+$/, "").trim().slice(0, 160);
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = "download";
  if (!path.extname(base) && mime) {
    const ext = MIME_EXT[String(mime).split(";")[0].trim().toLowerCase()];
    if (ext) base += ext;
  }
  return base;
}
function freeFilePath(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}
function findPcFile(spec) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("Give a file path to upload (like agent:notes.txt or all:photo.jpg).");
  const candidates = [raw];
  if (!/^(all|code|agent|ai|pictures|received):/i.test(raw)) {
    candidates.push("agent:" + raw, "all:" + raw, "all:Browser downloads/" + raw, "pictures:" + raw, "code:" + raw);
  } else if (/^(agent|ai):/i.test(raw)) {
    const rel = raw.replace(/^(agent|ai):\/*/i, "");
    candidates.push("all:" + rel, "all:Browser downloads/" + rel, "pictures:" + rel, "code:" + rel);
  }
  for (const c of candidates) {
    try {
      const r = agentFiles.resolve(c);
      const st = fs.statSync(r.full);
      if (st.isFile()) return { full: r.full, spec: r.spec, name: path.basename(r.full), size: st.size, mime: mimeOfName(r.full) };
    } catch {}
  }
  throw new Error(`File not found on the PC: "${raw}". Check the file name with list_files (in agent:, all:, pictures: or code:).`);
}
function findDownloadedFile(d) {
  try {
    if (d.filePath && fs.existsSync(d.filePath)) {
      const st = fs.statSync(d.filePath);
      return { name: path.basename(d.filePath), full: d.filePath, size: st.size };
    }
    const entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true })
      .filter((e) => e.isFile() && !/\.(crdownload|tmp|part)$/i.test(e.name))
      .map((e) => { const full = path.join(DOWNLOADS, e.name), st = fs.statSync(full); return { name: e.name, full, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    const fresh = entries.find((e) => e.mtime >= (d.at || 0) - 2500);
    if (fresh) return fresh;
    const exact = entries.find((e) => e.name === d.name);
    if (exact) return exact;
  } catch {}
  return null;
}

function chromePath() {
  const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const c = [...pf.map((d) => path.join(d, "Google", "Chrome", "Application", "chrome.exe")), ...pf.map((d) => path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"))];
  return c.find((x) => fs.existsSync(x)) || "";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = {
  proc: null, ws: null, id: 0, pend: new Map(), sessions: new Map(), active: null, starting: null,
  frame: null, seq: 0, tabs: [], nav: { url: "", title: "", back: false, fwd: false }, loading: false, dialog: null, download: "",
  downloads: new Map(), recentDownloads: [], fileChooser: null, lastDialog: null,
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
// where the AI's page reading, clicks and typing go: this hidden browser, or your own Chrome through the extension (browserext.js)
const pcD = { send: (method, params) => { const s = cur(); if (!s) throw new Error("The browser isn't open."); return send(method, params, s); }, loading: () => B.loading, vp: () => B.vp };

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
    case "Page.fileChooserOpened": if (mine) { B.fileChooser = { backendNodeId: p.backendNodeId, mode: p.mode || "selectSingle", at: Date.now() }; } break;
    case "Browser.downloadWillBegin": {
      const name = safeFileName(p.suggestedFilename || "download");
      B.download = "Downloading " + name + "…";
      B.downloads.set(p.guid, { guid: p.guid, name, url: p.url || "", state: "inProgress", received: 0, total: 0, at: Date.now() });
      wake(); break;
    }
    case "Browser.downloadProgress": {
      const d = B.downloads.get(p.guid) || { guid: p.guid, name: "download", url: "", at: Date.now() };
      d.received = p.receivedBytes || d.received || 0;
      d.total = p.totalBytes || d.total || 0;
      d.state = p.state || d.state;
      if (p.filePath) d.filePath = p.filePath;
      B.downloads.set(p.guid, d);
      if (p.state === "completed") {
        const found = findDownloadedFile(d);
        if (found) { d.name = found.name; d.full = found.full; d.size = found.size; }
        d.spec = "all:Browser downloads/" + d.name;
        d.doneAt = Date.now();
        B.recentDownloads.unshift(d); B.recentDownloads.length = Math.min(B.recentDownloads.length, 20);
        B.download = `Downloaded ${d.name} → PC files › Browser downloads`;
        B.note("Browser: downloaded " + d.name);
        wake();
      } else if (p.state === "canceled") { d.doneAt = Date.now(); B.download = "Download cancelled"; wake(); }
      break;
    }
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
  if (!s) {
    s = (await send("Target.attachToTarget", { targetId: id, flatten: true })).sessionId;
    B.sessions.set(id, s);
    await send("Page.enable", {}, s);
    await send("Page.setInterceptFileChooserDialog", { enabled: true }, s).catch(() => {});
  }
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
const KEY_ALIAS = { " ": "Space", Spacebar: "Space", Esc: "Escape", Return: "Enter", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Del: "Delete", PgUp: "PageUp", PgDn: "PageDown" };
const KEYS = { Enter: [13, "Enter", "\r"], Backspace: [8, "Backspace"], Tab: [9, "Tab"], Escape: [27, "Escape"], Space: [32, "Space", " "], Delete: [46, "Delete"], ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"], F5: [116, "F5"] };
async function input(j, D = pcD) {
  const mods = (j.alt ? 1 : 0) | (j.ctrl ? 2 : 0) | (j.meta ? 4 : 0) | (j.shift ? 8 : 0);
  const x = Number(j.x) || 0, y = Number(j.y) || 0, button = ["left", "right", "middle"].includes(j.button) ? j.button : "left";
  const mouse = (type, extra) => D.send("Input.dispatchMouseEvent", { type, x, y, modifiers: mods, ...extra });
  switch (j.t) {
    case "click": await mouse("mousePressed", { button, clickCount: j.count || 1 }); await mouse("mouseReleased", { button, clickCount: j.count || 1 }); break;
    case "down": await mouse("mousePressed", { button, clickCount: j.count || 1 }); break;
    case "up": await mouse("mouseReleased", { button, clickCount: j.count || 1 }); break;
    case "move": await mouse("mouseMoved", { button: j.drag ? "left" : "none", buttons: j.drag ? 1 : 0 }); break;
    case "wheel": await mouse("mouseWheel", { deltaX: Number(j.dx) || 0, deltaY: Number(j.dy) || 0 }); break;
    case "text": if (j.text) await D.send("Input.insertText", { text: String(j.text).slice(0, 5000) }); break;
    case "key": {
      const keyName = KEY_ALIAS[j.key] || j.key;
      let k = KEYS[keyName];
      if (!k && /^[a-z0-9]$/i.test(keyName || "")) { const c = keyName.toUpperCase(); k = [c.charCodeAt(0), /\d/.test(c) ? "Digit" + c : "Key" + c]; }
      if (!k) break;
      const [vk, code, text] = k;
      const domKey = keyName === "Space" ? " " : keyName;
      await D.send("Input.dispatchKeyEvent", { type: text && !mods ? "keyDown" : "rawKeyDown", key: domKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, ...(text && !mods ? { text, unmodifiedText: text } : {}) });
      await D.send("Input.dispatchKeyEvent", { type: "keyUp", key: domKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
      break;
    }
  }
}
// ---------- for the AI: read the page as text with numbered things to click, type into, upload to or download ----------
const READ_JS = `(() => {
  const vis = (e) => {
    if (e.tagName === "INPUT" && e.type === "file" && !e.disabled) return true;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  document.querySelectorAll("[data-alb]").forEach((e) => e.removeAttribute("data-alb"));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=listbox],[role=searchbox],[role=textbox],[contenteditable]:not([contenteditable=false]),summary,[download],canvas,img[src],video[src],audio[src]';
  const raw = [...document.querySelectorAll(sel)].filter((e) => {
    if (!vis(e)) return false;
    if (e.tagName === "IMG") { const r = e.getBoundingClientRect(); if (r.width < 48 || r.height < 48 || e.closest("a[href],button,[role=button]")) return false; }
    return true;
  });
  const fileInputs = raw.filter((e) => e.tagName === "INPUT" && e.type === "file");
  const els = raw.slice(0, 120);
  for (const fi of fileInputs) if (!els.includes(fi) && els.length < 125) els.push(fi);
  const clean = (s, n = 80) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const labelOf = (e) => {
    const tag = e.tagName.toLowerCase(), type = (e.type || "").toLowerCase();
    const aria = e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") && document.getElementById(e.getAttribute("aria-labelledby"))?.innerText) || "";
    const lbl = (e.labels && e.labels[0] && e.labels[0].innerText) || (tag === "input" && e.closest("label")?.innerText) || "";
    if (tag === "select") return clean(aria || lbl || e.getAttribute("placeholder") || e.title || e.name || e.id || "Dropdown");
    if (tag === "input" && (type === "checkbox" || type === "radio")) return clean(aria || lbl || e.title || e.name || e.id || type);
    if (tag === "input" && type === "file") {
      const near = e.closest("label,button,[role=button],form,div")?.innerText || "";
      return clean(aria || lbl || e.title || e.getAttribute("placeholder") || near || e.name || "Upload file");
    }
    if (tag === "input" || tag === "textarea") return clean(aria || lbl || e.getAttribute("placeholder") || e.title || e.name || e.value || "");
    if (tag === "img") return clean(e.alt || e.title || aria || (e.src && e.src.split("/").pop().split("?")[0]) || "image");
    return clean(aria || e.innerText || e.value || e.getAttribute("placeholder") || e.title || e.alt || e.querySelector?.("img[alt]")?.alt || e.name || "");
  };
  const elements = els.map((e, i) => {
    e.setAttribute("data-alb", String(i + 1));
    const tag = e.tagName.toLowerCase(), type = (e.type || "text").toLowerCase(), role = (e.getAttribute("role") || "").toLowerCase();
    const kind = tag === "a" ? "link" : tag === "input" ? "input:" + type : e.isContentEditable ? "editable" : role && (tag === "div" || tag === "span" || tag === "li") ? role : tag;
    const item = { n: i + 1, kind, label: labelOf(e) };
    if (tag === "a" && e.href) item.href = String(e.href).slice(0, 200);
    if ((tag === "img" || tag === "video" || tag === "audio") && (e.currentSrc || e.src)) item.src = String(e.currentSrc || e.src).slice(0, 200);
    if (e.hasAttribute("download")) item.download = true;
    if (tag === "select") {
      const selOpt = e.selectedOptions && e.selectedOptions[0];
      item.value = clean(selOpt ? selOpt.text || selOpt.value : e.value, 60);
      item.options = [...(e.options || [])].slice(0, 15).map((o) => clean(o.text || o.value, 50)).filter(Boolean);
    } else if (tag === "input" && (type === "checkbox" || type === "radio")) {
      item.checked = !!e.checked;
    } else if (role === "checkbox" || role === "switch" || role === "radio") {
      item.checked = e.getAttribute("aria-checked") === "true";
    } else if (tag === "input" && type === "file") {
      if (e.accept) item.accept = clean(e.accept, 60);
      if (e.files && e.files.length) item.value = [...e.files].map((f) => f.name).join(", ");
    } else if ((tag === "input" && !/^(button|submit|reset|image|password)$/.test(type)) || tag === "textarea") {
      if (e.value) item.value = clean(e.value, 80);
    } else if (e.isContentEditable) {
      const t = clean(e.innerText, 80); if (t && t !== item.label) item.value = t;
    }
    return item;
  });
  let scrolled = Math.round(scrollY), pageHeight = document.documentElement.scrollHeight;
  if (pageHeight <= innerHeight + 5 && document.body) {
    const sc = [...document.querySelectorAll("main,section,article,div")].find((x) => x.scrollHeight > x.clientHeight + 40 && x.clientHeight > innerHeight * 0.4 && /(auto|scroll)/.test(getComputedStyle(x).overflowY));
    if (sc) { scrolled = Math.round(sc.scrollTop); pageHeight = sc.scrollHeight; }
  }
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000), elements, scrolled, pageHeight, windowHeight: innerHeight };
})()`;
async function clearDialogForAi(D = pcD, accept = true, promptText) {
  const dlg = D === pcD ? B.dialog : ext.status().dialog;
  if (!dlg) return null;
  try {
    await D.send("Page.handleJavaScriptDialog", { accept: !!accept, ...(promptText != null ? { promptText: String(promptText) } : {}) });
    if (D === pcD) B.dialog = null;
    await sleep(120);
  } catch {}
  B.lastDialog = { ...dlg, handled: accept ? "accepted" : "dismissed", at: Date.now() };
  return B.lastDialog;
}
async function evalJs(expression, D = pcD) {
  await clearDialogForAi(D);
  const r = await D.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("The page didn't answer: " + (r.exceptionDetails.text || "error"));
  return r.result ? r.result.value : null;
}
async function settle(ms = 10000, D = pcD) {   // wait until the page has loaded (or give up quietly)
  const end = Date.now() + ms; await sleep(400);
  while (D.loading() && Date.now() < end) await sleep(200);
  if (D === pcD) {
    const dlEnd = Date.now() + 12000;
    while (Date.now() < dlEnd && [...B.downloads.values()].some((d) => d.state === "inProgress" && Date.now() - d.at < 30000)) await sleep(250);
  }
  await sleep(300);
}
async function readPage(D = pcD) {
  const p = (await evalJs(READ_JS, D)) || { url: "", title: "", text: "", elements: [], scrolled: 0, pageHeight: 0, windowHeight: 0 };
  const recent = B.recentDownloads.filter((d) => Date.now() - (d.doneAt || d.at || 0) < 60000).slice(0, 5)
    .map((d) => ({ name: d.name, state: d.state, spec: d.spec, size: d.size || 0 }));
  if (recent.length) p.downloads = recent;
  if (B.lastDialog && Date.now() - B.lastDialog.at < 15000) { p.dialog = B.lastDialog; B.lastDialog = null; }
  if (D === pcD && B.tabs.length > 1) p.tabs = B.tabs.map((t) => ({ id: t.id, title: t.title || t.url, url: t.url, active: t.id === B.active }));
  return p;
}
async function ensureNumbered(D = pcD) {
  const has = await evalJs('!!document.querySelector("[data-alb]")', D).catch(() => false);
  if (!has) await evalJs(READ_JS, D).catch(() => {});
}
const SCROLL_JS = (dir, n) => `(() => {
  const k = ${dir === "up" ? -0.8 : 0.8};
  const el = ${n ? `document.querySelector('[data-alb="${Math.round(Number(n))}"]')` : "null"};
  if (el) {
    let sc = el;
    while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (sc && sc !== document.body) { sc.scrollBy(0, k * sc.clientHeight); return true; }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  }
  const y0 = scrollY; scrollBy(0, k * innerHeight);
  if (Math.abs(scrollY - y0) > 2) return true;
  const box = [...document.querySelectorAll("main,section,article,div")].find((x) => x.scrollHeight > x.clientHeight + 40 && x.clientHeight > innerHeight * 0.4 && /(auto|scroll)/.test(getComputedStyle(x).overflowY));
  if (box) { box.scrollBy(0, k * box.clientHeight); return true; }
  return false;
})()`;
// In your own Chrome the Agent's tab is usually in the background, where Chrome holds back mouse and keyboard events: clicks and
// typing are done inside the page instead (the same events a site sees from a real click; values set so React & co. notice them).
const DOM_ACT = (j) => `(() => {
  const e = document.querySelector('[data-alb="${Math.round(Number(j.n))}"]'); if (!e) return null;
  const label = (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || e.name || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const action = ${JSON.stringify(j.action)}, text = ${JSON.stringify(String(j.text ?? j.value ?? ""))}, clear = ${j.clear !== false}, submit = ${!!j.submit};
  if (action === "type" && e.type === "password") return { password: true, label };
  e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  try { e.focus({ preventScroll: true }); } catch {}
  if (action === "click") {
    if (e.tagName === "A" && e.target === "_blank" && e.href && !/^javascript:/i.test(e.href)) e.removeAttribute("target");
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    e.dispatchEvent(new PointerEvent("pointerdown", o)); e.dispatchEvent(new MouseEvent("mousedown", o));
    e.dispatchEvent(new PointerEvent("pointerup", o)); e.dispatchEvent(new MouseEvent("mouseup", o));
    e.click();
    return { ok: true, label };
  }
  if (e instanceof HTMLSelectElement || action === "select") {
    if (!(e instanceof HTMLSelectElement)) return { notSelect: true, label };
    const want = text.trim(), low = want.toLowerCase(), opts = [...e.options];
    const pick = opts.find((o) => o.value === want || o.text.trim() === want)
      || opts.find((o) => o.value.toLowerCase() === low || o.text.trim().toLowerCase() === low)
      || opts.find((o) => o.text.trim().toLowerCase().includes(low) || o.value.toLowerCase().includes(low));
    if (!pick) return { badOption: true, label, options: opts.slice(0, 15).map((o) => o.text.trim() || o.value) };
    e.selectedIndex = opts.indexOf(pick); e.value = pick.value;
    e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, label, selected: pick.text.trim() || pick.value };
  }
  if (e.isContentEditable) {
    if (clear) { try { document.execCommand("selectAll"); } catch {} e.innerText = ""; }
    if (!document.execCommand("insertText", false, text)) e.innerText = (clear ? "" : e.innerText) + text;
    e.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = (clear ? "" : e.value) + text;
    if (set) set.call(e, next); else e.value = next;
    e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (submit) {
    const k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const go = e.dispatchEvent(new KeyboardEvent("keydown", k)); e.dispatchEvent(new KeyboardEvent("keypress", k)); e.dispatchEvent(new KeyboardEvent("keyup", k));
    if (go && e.form) { try { e.form.requestSubmit(); } catch { e.form.submit(); } }
  }
  return { ok: true, label };
})()`;
async function navStep(action, D = pcD) {
  if (action === "reload") await D.send("Page.reload", {});
  else if (action === "back" || action === "forward") {
    const h = await D.send("Page.getNavigationHistory", {}), e = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
    if (!e) throw new Error(`Can't go ${action}: no page in history.`);
    await D.send("Page.navigateToHistoryEntry", { entryId: e.id });
  }
  await settle(6000, D);
  return { ok: true, key: action };
}
async function domAct(j, D) {
  if (j.action === "scroll") { await evalJs(SCROLL_JS(j.direction, j.n), D); await sleep(400); return { ok: true }; }
  if (j.action === "key") {
    const rawKey = String(j.key || "").trim();
    if (/^(back|forward|reload)$/i.test(rawKey)) return navStep(rawKey.toLowerCase(), D);
    const keyName = KEY_ALIAS[rawKey] || rawKey;
    if (j.n != null) await ensureNumbered(D);
    await evalJs(`(() => {
      const n = ${j.n != null ? Math.round(Number(j.n)) : 0};
      const el = (n && document.querySelector('[data-alb="' + n + '"]')) || document.activeElement || document.body;
      if (el && el.focus) try { el.focus({ preventScroll: true }); } catch {}
      const key = ${JSON.stringify(keyName === "Space" ? " " : keyName)}, code = ${JSON.stringify((KEYS[keyName] && KEYS[keyName][1]) || keyName)}, vk = ${(KEYS[keyName] && KEYS[keyName][0]) || 0};
      const o = { key, code, keyCode: vk, which: vk, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent("keydown", o));
      el.dispatchEvent(new KeyboardEvent("keypress", o));
      el.dispatchEvent(new KeyboardEvent("keyup", o));
      if (go && key === "Enter" && el.form) { try { el.form.requestSubmit(); } catch { el.form.submit(); } }
    })()`, D);
    await sleep(300); await settle(4000, D);
    return { ok: true, key: keyName };
  }
  await ensureNumbered(D);
  const r = await evalJs(DOM_ACT(j), D);
  if (!r) throw new Error(`There is no number ${Math.round(Number(j.n))} on the page any more. Read the page again.`);
  if (r.password) throw new Error("Passwords are never typed by the AI. Ask the user to type it in their Chrome themselves.");
  if (r.badOption) throw new Error(`No option "${j.text ?? j.value}" in "${r.label}". Options: ${(r.options || []).join(", ")}`);
  await sleep(500); await settle(6000, D);
  return { ok: true, on: r.label, ...(r.selected ? { selected: r.selected } : {}) };
}
async function act(j, D = pcD) {
  if (j.action === "upload") return uploadFile(j, D);
  if (j.action === "download") return downloadFromBrowser(j, D);
  if (D.dom) return domAct(j, D);
  if (j.action === "scroll") {
    const moved = await evalJs(SCROLL_JS(j.direction, j.n), D).catch(() => false);
    if (!moved) { const v = D.vp(); await input({ t: "wheel", x: Math.round(v.w / 2), y: Math.round(v.h / 2), dy: (j.direction === "up" ? -0.8 : 0.8) * v.h }, D); }
    await sleep(500); return { ok: true };
  }
  if (j.action === "key") {
    const rawKey = String(j.key || "").trim();
    if (/^(back|forward|reload)$/i.test(rawKey)) return navStep(rawKey.toLowerCase(), D);
    const keyName = KEY_ALIAS[rawKey] || rawKey;
    const dlg = D === pcD ? B.dialog : ext.status().dialog;
    if (dlg && (keyName === "Enter" || keyName === "Escape")) { await clearDialogForAi(D, keyName === "Enter"); return { ok: true, key: keyName }; }
    if (j.n != null) {
      await ensureNumbered(D);
      await evalJs(`(() => { const e = document.querySelector('[data-alb="${Math.round(Number(j.n))}"]'); if (e) { e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); try { e.focus({ preventScroll: true }); } catch {} } })()`, D);
    }
    await input({ t: "key", key: keyName }, D);
    await sleep(250); await settle(4000, D);
    return { ok: true, key: keyName };
  }
  await ensureNumbered(D);
  const n = Math.round(Number(j.n));
  if (j.action === "select") return domAct({ ...j, action: "select" }, D);
  const r = await evalJs(`(() => {
    const e = document.querySelector('[data-alb="${n}"]'); if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const b = e.getBoundingClientRect();
    const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
    const hit = b.width > 0 && b.height > 0 ? document.elementFromPoint(x, y) : null;
    const covered = !hit || (hit !== e && !e.contains(hit) && !hit.contains(e));
    window.__albClicked = false;
    e.addEventListener("click", () => { window.__albClicked = true; }, { once: true, capture: true });
    return { x, y, covered, isSelect: e instanceof HTMLSelectElement, password: e.type === "password", label: (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || e.name || "").replace(/\\s+/g, " ").trim().slice(0, 80) };
  })()`, D);
  if (!r) throw new Error(`There is no number ${n} on the page any more. Read the page again.`);
  if (j.action === "type" && r.password) throw new Error("Passwords are never typed by the AI. Ask the user to type it in the Browser themselves.");
  if (r.isSelect && j.action === "type") return domAct(j, D);
  await sleep(100);
  if (j.action === "click") {
    if (r.covered) return domAct(j, D);
    await input({ t: "click", x: r.x, y: r.y }, D);
    if (!(await evalJs("!!window.__albClicked", D).catch(() => true))) await evalJs(DOM_ACT(j), D);
  } else if (!r.covered) {
    await input({ t: "click", x: r.x, y: r.y }, D);
  }
  if (j.action === "type") {
    await sleep(80);
    // Focus and set/clear inside the element itself so Ctrl+A never selects the whole page if a click missed
    await evalJs(DOM_ACT({ ...j, submit: false }), D);
    if (j.submit) await input({ t: "key", key: "Enter" }, D);
  }
  await settle(6000, D);
  return { ok: true, on: r.label };
}

// ---------- uploading (inserting) a file from the PC into the browser, and downloading a file from the browser to the PC ----------
async function uploadFile(j, D = pcD) {
  let file;
  if (j.b64) {
    const buf = Buffer.from(String(j.b64), "base64");
    if (buf.length > 25 * 1024 * 1024) throw new Error("Files up to 25 MB can be uploaded from the chat.");
    const name = safeFileName(j.name || "upload.bin", j.mime);
    const dir = path.join(agentFiles.ROOTS.agent.dir, "Uploads");
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    file = { full, spec: "agent:Uploads/" + name, name, size: buf.length, mime: j.mime || mimeOfName(name) };
  } else {
    file = findPcFile(j.path || j.spec);
  }
  await clearDialogForAi(D);
  if (j.n != null) await ensureNumbered(D);
  const n = j.n != null && j.n !== "" ? Math.round(Number(j.n)) : 0;
  try {
    const prep = await evalJs(`(() => {
      window.__albTargetInput = null;
      window.__albDropTarget = null;
      window.__albChangeFired = false;
      if (!HTMLInputElement.prototype.__albOrigClick) HTMLInputElement.prototype.__albOrigClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === "file") { window.__albTargetInput = this; return; }
        return HTMLInputElement.prototype.__albOrigClick.apply(this, arguments);
      };
      const n = ${n};
      const e = n ? document.querySelector('[data-alb="' + n + '"]') : null;
      if (n && !e) return { missing: true };
      const labelOf = (x) => x ? (x.getAttribute("aria-label") || x.innerText || x.value || x.placeholder || x.title || x.name || "file input").replace(/\\s+/g, " ").trim().slice(0, 80) : "file input";
      if (e) {
        e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        if (e.tagName === "INPUT" && e.type === "file") window.__albTargetInput = e;
        else if (e.tagName === "LABEL" && e.control && e.control.type === "file") window.__albTargetInput = e.control;
        else if (e.querySelector && e.querySelector("input[type=file]")) window.__albTargetInput = e.querySelector("input[type=file]");
        else {
          const o = { bubbles: true, cancelable: true, view: window, button: 0 };
          e.dispatchEvent(new PointerEvent("pointerdown", o)); e.dispatchEvent(new MouseEvent("mousedown", o));
          e.dispatchEvent(new PointerEvent("pointerup", o)); e.dispatchEvent(new MouseEvent("mouseup", o));
          try { e.click(); } catch {}
          if (!window.__albTargetInput) {
            const scope = e.closest("label,form,div,section,main") || document;
            window.__albTargetInput = scope.querySelector("input[type=file]:not([disabled])") || document.querySelector("input[type=file]:not([disabled])");
          }
          window.__albDropTarget = e;
        }
      } else {
        window.__albTargetInput = document.querySelector("input[type=file]:not([disabled])") || document.querySelector("input[type=file]");
        window.__albDropTarget = document.activeElement || document.body;
      }
      if (window.__albTargetInput) window.__albTargetInput.addEventListener("change", () => { window.__albChangeFired = true; }, { once: true });
      return { hasInput: !!window.__albTargetInput, hasDrop: !!window.__albDropTarget, label: labelOf(e || window.__albTargetInput || window.__albDropTarget) };
    })()`, D);
    if (prep && prep.missing) throw new Error(`There is no number ${n} on the page any more. Read the page again.`);
    let setOk = false;
    if (prep && prep.hasInput) {
      try {
        const obj = await D.send("Runtime.evaluate", { expression: "window.__albTargetInput", returnByValue: false });
        if (obj && obj.result && obj.result.objectId) {
          await D.send("DOM.setFileInputFiles", { objectId: obj.result.objectId, files: [file.full] });
          setOk = await evalJs("!!(window.__albTargetInput && window.__albTargetInput.files && window.__albTargetInput.files.length)", D);
        }
      } catch {}
    } else if (D === pcD && B.fileChooser && Date.now() - B.fileChooser.at < 30000) {
      try {
        await D.send("DOM.setFileInputFiles", { backendNodeId: B.fileChooser.backendNodeId, files: [file.full] });
        B.fileChooser = null; setOk = true;
      } catch {}
    }
    // Fallback / drop-zone delivery using DataTransfer + File inside the page (also ensures input/change events fire)
    if (!setOk || (prep && prep.hasInput)) {
      const canInline = !setOk && file.size <= 25 * 1024 * 1024;
      const b64 = canInline ? fs.readFileSync(file.full).toString("base64") : "";
      const doneInDom = await evalJs(`(() => {
        const inp = window.__albTargetInput, drop = window.__albDropTarget;
        let dt = null;
        if (${JSON.stringify(b64)}) {
          const bin = atob(${JSON.stringify(b64)}), u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const f = new File([u8], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.mime)}, lastModified: Date.now() });
          dt = new DataTransfer(); dt.items.add(f);
        }
        if (inp) {
          if (dt && (!inp.files || !inp.files.length)) inp.files = dt.files;
          if (!window.__albChangeFired) {
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return !!(inp.files && inp.files.length);
        }
        if (drop && dt) {
          for (const t of ["dragenter", "dragover", "drop"]) {
            drop.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
          }
          try { drop.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); } catch {}
          return true;
        }
        return false;
      })()`, D);
      if (doneInDom) setOk = true;
    }
    if (!setOk) throw new Error("No file input or upload area was found on the page. Click the page's upload button first or give its element number n.");
    B.note(`Browser: uploaded ${file.name}`);
    await settle(6000, D);
    return { ok: true, file: file.name, spec: file.spec, size: file.size, on: (prep && prep.label) || "page" };
  } finally {
    await evalJs("if (HTMLInputElement.prototype.__albOrigClick) HTMLInputElement.prototype.click = HTMLInputElement.prototype.__albOrigClick; delete window.__albTargetInput; delete window.__albDropTarget;", D).catch(() => {});
  }
}

function saveDownloadedBuffer(buf, rawName, mime, destSpec) {
  const cleanName = safeFileName(rawName, mime);
  const dlFull = freeFilePath(DOWNLOADS, cleanName);
  fs.writeFileSync(dlFull, buf);
  const savedName = path.basename(dlFull);
  let spec = "all:Browser downloads/" + savedName, finalName = savedName;
  if (destSpec) {
    const r = agentFiles.resolve(destSpec, { write: true });
    fs.mkdirSync(path.dirname(r.full), { recursive: true });
    fs.writeFileSync(r.full, buf);
    spec = r.spec; finalName = path.basename(r.full);
  }
  const entry = { guid: "manual-" + Date.now(), name: finalName, spec, size: buf.length, state: "completed", at: Date.now(), doneAt: Date.now() };
  B.recentDownloads.unshift(entry); B.recentDownloads.length = Math.min(B.recentDownloads.length, 20);
  B.download = `Downloaded ${ savedName } → PC files › Browser downloads`;
  B.note("Browser: downloaded " + finalName);
  wake();
  return { ok: true, name: finalName, spec, size: buf.length, mime: mime || mimeOfName(finalName) };
}

async function fetchUrlFromBrowser(targetUrl, D = pcD) {
  // 1) Try inside the page first so blob:, data: and same-site authenticated downloads work directly
  try {
    const inPage = await evalJs(`(async () => {
      const r = await fetch(${JSON.stringify(targetUrl)}, { credentials: "include" });
      if (!r.ok) return { error: "HTTP " + r.status };
      const disp = r.headers.get("content-disposition") || "";
      const m = /filename\\*?=(?:UTF-8''|")?([^";\\r\\n]+)/i.exec(disp);
      const fname = m ? decodeURIComponent(m[1].trim().replace(/^["']|["']$/g, "")) : "";
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      const blob = await r.blob();
      if (blob.size > 30 * 1024 * 1024) return { tooBig: true };
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = rej; fr.readAsDataURL(blob); });
      return { ok: true, b64, mime: type || blob.type || "", name: fname };
    })()`, D);
    if (inPage && inPage.ok && inPage.b64) return { buf: Buffer.from(inPage.b64, "base64"), mime: inPage.mime, name: inPage.name };
  } catch {}
  // 2) Fallback: fetch from Node using the browser's cookies for that URL (bypasses CORS and handles cross-origin CDNs)
  if (!/^https?:\/\//i.test(targetUrl)) return null;
  let cookieHeader = "";
  try {
    const c = await D.send("Network.getCookies", { urls: [targetUrl] });
    if (c && Array.isArray(c.cookies) && c.cookies.length) cookieHeader = c.cookies.map((x) => `${x.name}=${x.value}`).join("; ");
  } catch {}
  const res = await fetch(targetUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: { ...(B.ua ? { "User-Agent": B.ua } : {}), ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
  });
  if (!res.ok) throw new Error("Download returned HTTP " + res.status);
  const disp = res.headers.get("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i.exec(disp);
  const fname = m ? decodeURIComponent(m[1].trim().replace(/^["']|["']$/g, "")) : "";
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
  const ab = await res.arrayBuffer();
  if (ab.byteLength > 100 * 1024 * 1024) throw new Error("Download is larger than 100 MB.");
  return { buf: Buffer.from(ab), mime, name: fname || path.basename(new URL(res.url || targetUrl).pathname) };
}

async function downloadFromBrowser(j, D = pcD) {
  await clearDialogForAi(D);
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const destSpec = j.path ? String(j.path).trim() : "";
  const wantName = destSpec ? path.basename(destSpec.split(":").pop()) : "";
  let info = null;
  if (j.n != null && j.n !== "") {
    await ensureNumbered(D);
    const n = Math.round(Number(j.n));
    info = await evalJs(`(() => {
      const e = document.querySelector('[data-alb="${n}"]'); if (!e) return null;
      const tag = e.tagName.toLowerCase();
      const label = (e.getAttribute("aria-label") || e.innerText || e.alt || e.title || e.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
      if (tag === "canvas") { try { return { tag, label: label || "canvas.png", dataUrl: e.toDataURL("image/png") }; } catch {} }
      const sub = e.querySelector && e.querySelector("a[href],img[src],video[src],audio[src],source[src]");
      const href = e.href || e.currentSrc || e.src || (sub && (sub.href || sub.currentSrc || sub.src)) || "";
      const dl = e.getAttribute("download") || (sub && sub.getAttribute && sub.getAttribute("download")) || "";
      return { tag, label, href: String(href || ""), download: dl, isMedia: /^(img|video|audio|source)$/.test(tag) || e.hasAttribute("download") };
    })()`, D);
    if (!info) throw new Error(`There is no number ${n} on the page any more. Read the page again.`);
  }
  const targetUrl = String(j.url || (info && (info.dataUrl || info.href)) || "").trim();
  // 1) data: URL or <canvas>
  if (targetUrl.startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(targetUrl);
    if (!m) throw new Error("Invalid data URL");
    const mime = m[1] || "application/octet-stream";
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
    return saveDownloadedBuffer(buf, wantName || (info && (info.download || info.label)) || "download", mime, destSpec);
  }
  // 2) blob: URL or direct media/file URL (when no button click is needed)
  const looksLikeFileUrl = /^blob:/i.test(targetUrl) || (info && info.isMedia) || (!j.n && /^https?:\/\//i.test(targetUrl))
    || /\.(pdf|zip|csv|json|xml|txt|md|png|jpe?g|gif|webp|svg|bmp|mp3|wav|mp4|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub)(\?|$)/i.test(targetUrl);
  if (targetUrl && looksLikeFileUrl) {
    const got = await fetchUrlFromBrowser(targetUrl, D).catch(() => null);
    if (got && got.buf) {
      const name = wantName || (info && info.download) || got.name || path.basename(targetUrl.split(/[?#]/)[0]) || (info && info.label) || "download";
      return saveDownloadedBuffer(got.buf, name, got.mime, destSpec);
    }
  }
  // 3) Click element n to trigger a download (catches both JS <a download> blobs and native Chrome downloads)
  if (j.n != null && j.n !== "") {
    const dlStart = Date.now();
    await evalJs(`(() => {
      window.__albDlCaptured = null;
      if (!HTMLAnchorElement.prototype.__albOrigClick) HTMLAnchorElement.prototype.__albOrigClick = HTMLAnchorElement.prototype.click;
      if (!URL.__albOrigCreate) URL.__albOrigCreate = URL.createObjectURL;
      if (!URL.__albOrigRevoke) URL.__albOrigRevoke = URL.revokeObjectURL;
      URL.createObjectURL = function () { const u = URL.__albOrigCreate.apply(this, arguments); window.__albDlCaptured = { href: u, download: (window.__albDlCaptured && window.__albDlCaptured.download) || "" }; return u; };
      URL.revokeObjectURL = function (u) { setTimeout(() => { try { URL.__albOrigRevoke.call(URL, u); } catch {} }, 5000); };
      HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute("download") || /^blob:|^data:/i.test(this.href || "")) {
          window.__albDlCaptured = { href: this.href, download: this.getAttribute("download") || this.download || "" };
          if (/^blob:|^data:/i.test(this.href || "")) return;
        }
        return HTMLAnchorElement.prototype.__albOrigClick.apply(this, arguments);
      };
    })()`, D).catch(() => {});
    try {
      await act({ action: "click", n: j.n }, D);
      const cap = await evalJs("window.__albDlCaptured", D).catch(() => null);
      if (cap && cap.href) {
        if (cap.href.startsWith("data:")) return downloadFromBrowser({ url: cap.href, path: destSpec }, D);
        const got = await fetchUrlFromBrowser(cap.href, D).catch(() => null);
        if (got && got.buf) return saveDownloadedBuffer(got.buf, wantName || cap.download || got.name || "download", got.mime, destSpec);
      }
      // Wait if a native Chrome download started
      if (D === pcD) {
        const waitEnd = Date.now() + 20000;
        while (Date.now() < waitEnd && [...B.downloads.values()].some((d) => d.at >= dlStart - 100 && d.state === "inProgress")) await sleep(250);
        const doneDl = B.recentDownloads.find((d) => !String(d.guid).startsWith("manual-") && (d.at || 0) >= dlStart - 100 && d.state === "completed");
        if (doneDl) {
          let spec = doneDl.spec, finalName = doneDl.name;
          if (destSpec && doneDl.full && fs.existsSync(doneDl.full)) {
            const r = agentFiles.resolve(destSpec, { write: true });
            fs.mkdirSync(path.dirname(r.full), { recursive: true });
            fs.copyFileSync(doneDl.full, r.full);
            spec = r.spec; finalName = path.basename(r.full);
          }
          return { ok: true, name: finalName, spec, size: doneDl.size || 0, mime: mimeOfName(finalName) };
        }
      }
    } finally {
      await evalJs("if (HTMLAnchorElement.prototype.__albOrigClick) HTMLAnchorElement.prototype.click = HTMLAnchorElement.prototype.__albOrigClick; if (URL.__albOrigCreate) URL.createObjectURL = URL.__albOrigCreate; if (URL.__albOrigRevoke) URL.revokeObjectURL = URL.__albOrigRevoke; delete window.__albDlCaptured;", D).catch(() => {});
    }
  }
  // 4) Final fallback: if we have an http(s) URL (from j.url or element n's href), fetch and save it
  if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
    const got = await fetchUrlFromBrowser(targetUrl, D);
    if (got && got.buf) {
      const name = wantName || (info && info.download) || got.name || path.basename(new URL(targetUrl).pathname) || "download";
      return saveDownloadedBuffer(got.buf, name, got.mime, destSpec);
    }
  }
  throw new Error("Couldn't download a file from that element. Check the element number with browser_read or give a direct url.");
}
// Private: a separate session like an incognito window. Nothing it sees is written to the profile (no history, cookies, logins),
// and switching it off throws the whole session away.
async function setPrivate(on) {
  if (on && !B.priv) {
    B.priv = (await send("Target.createBrowserContext", { disposeOnDetach: false })).browserContextId;
    await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, browserContextId: B.priv, eventsEnabled: true }).catch(() => {});
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
// ---------- the Browser view mirroring your own Chrome (Agent browser = My Chrome) ----------
// The same view as for the hidden browser, but the picture is the tab the AI uses in your Chrome (or the one you're on when the
// sidebar follows your tab), and clicks, typing and the address bar go there. It's one browser: what you see in the app is what
// the Chrome extension sees.
async function extState() {
  const s = ext.status();
  if (!s.connected) throw new Error("Your Chrome isn't connected. Open Chrome on the PC (the Albatross extension connects by itself), or switch to the PC browser in Settings → Tools → Work on your PC.");
  if (s.paused) throw new Error("The AI is paused in your Chrome. Resume it in the Chrome sidebar or in Settings → Tools.");
  if (!s.tab) await ext.driver.open("https://www.google.com/");
  const t = ext.status().tab || {};
  let nav = {};
  try { const h = await ext.driver.send("Page.getNavigationHistory", {}); const e = h.entries[h.currentIndex] || {}; nav = { url: e.url, title: e.title, back: h.currentIndex > 0, fwd: h.currentIndex < h.entries.length - 1 }; } catch {}
  return { private: false, chrome: true, follow: !!s.follow, url: nav.url || t.url || "", title: nav.title || t.title || "", back: !!nav.back, fwd: !!nav.fwd, loading: ext.driver.loading(), dialog: s.dialog, download: "", active: t.id, tabs: t.id ? [{ id: t.id, title: t.title || t.url, url: t.url }] : [] };
}
// The AI's web search you can watch: it opens a search page in a tab of its own and reads the results there. Bing first
// (DuckDuckGo asks remote-controlled browsers to solve a captcha), DuckDuckGo if Bing shows nothing.
const ENGINES = [
  { url: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=de", js: `(() => [...document.querySelectorAll("li.b_algo")].slice(0, 8).map((r) => {
    const a = r.querySelector("h2 a"); if (!a) return null;
    let u = a.href;
    try { const x = new URL(u); const enc = x.hostname.endsWith("bing.com") && x.searchParams.get("u"); if (enc && enc.startsWith("a1")) u = atob(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/")); } catch {}
    const sn = r.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_paractl");
    return { title: a.textContent.trim(), url: u, content: sn ? sn.textContent.trim().slice(0, 600) : "" };
  }).filter(Boolean))()` },
  { url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), js: `(() => [...document.querySelectorAll(".result")].filter((r) => !r.className.includes("result--ad")).slice(0, 8).map((r) => {
    const a = r.querySelector("a.result__a"); if (!a) return null;
    let u = a.href; try { const q = new URL(u).searchParams.get("uddg"); if (q) u = q; } catch {}
    const sn = r.querySelector(".result__snippet");
    return { title: a.textContent.trim(), url: u, content: sn ? sn.textContent.trim().slice(0, 600) : "" };
  }).filter(Boolean))()` },
];
async function searchIn(D, openTab, query) {
  const q = String(query || "").slice(0, 300);
  for (const e of ENGINES) {
    try {
      await openTab(e.url(q));
      await settle(10000, D);
      const results = (await evalJs(e.js, D)) || [];
      if (results.length) return { results, via: "browser" };
    } catch {}
  }
  throw new Error("The search pages showed no results (they may have asked for a captcha).");
}
async function extHandle(p, j) {
  const D = ext.driver;
  if (p === "/browser/search") { if (!ext.status().connected) throw new Error("Your Chrome isn't connected."); return searchIn(D, (u) => D.newTab(u), j.query); }
  if (p === "/browser/start" || p === "/browser/viewport" || p === "/browser/state") return extState();
  if (p === "/browser/input") { await input(j, D); return { ok: true }; }
  if (p === "/browser/nav") {
    if (j.action === "back" || j.action === "forward") { const h = await D.send("Page.getNavigationHistory", {}), e = h.entries[h.currentIndex + (j.action === "back" ? -1 : 1)]; if (e) await D.send("Page.navigateToHistoryEntry", { entryId: e.id }); }
    else if (j.action === "reload") await D.send("Page.reload", {});
    else if (j.action === "stop") await D.send("Page.stopLoading", {});
    else { const u = fixUrl(j.url); if (!u) throw new Error("That address can't be opened here."); await D.open(u); }
    await sleep(300); return extState();
  }
  if (p === "/browser/tab") {
    if (j.action === "new") await D.open(fixUrl(j.url) || "https://www.google.com/");
    else if (j.action === "close") await ext.handle({ action: "closetab" });
    return extState();
  }
  if (p === "/browser/dialog") { await D.send("Page.handleJavaScriptDialog", { accept: !!j.accept, promptText: j.text != null ? String(j.text) : undefined }); return extState(); }
  if (p === "/browser/stop") return { closed: true };
  if (p === "/browser/private" || p === "/browser/clearhistory") throw new Error("That's for the PC browser. In your own Chrome use Chrome's own private window and history.");
  return null;
}
async function extStream(j, write, signal, busy) {
  const fps = Math.max(1, Math.min(30, Number(j.fps) || 10)), gap = 1000 / fps;
  let seq = -1, st = "", last = 0, castAt = 0, stTick = 0;
  const cast = async () => { castAt = Date.now(); try { await ext.driver.send("Page.startScreencast", { format: "jpeg", quality: Math.max(30, Math.min(80, Number(j.quality) || 60)), maxWidth: 1920, maxHeight: 1600, everyNthFrame: 1 }); } catch {} };
  try {
    write(JSON.stringify({ st: await extState() }) + "\n");
    await cast();
    for (;;) {
      if (signal && signal.aborted) return;
      const { frame, seq: s } = ext.mirror.frame(), now = Date.now();
      // no picture for a while: the tab changed (follow) or Chrome stopped sending (a background tab doesn't paint): ask again
      if ((!frame || s === seq) && now - castAt > 3000) await cast();
      if (now - stTick > 1500) { stTick = now; try { const n = JSON.stringify(await extState()); if (n !== st) { st = n; write(JSON.stringify({ st: JSON.parse(n) }) + "\n"); } } catch (e) { write(JSON.stringify({ error: e.message }) + "\n"); } }
      if (frame && s !== seq && now - last >= gap && !(busy && busy())) { write(JSON.stringify({ img: frame.data, w: frame.w, h: frame.h }) + "\n"); seq = s; last = now; continue; }
      await ext.mirror.wait(frame && s !== seq ? Math.max(20, gap - (now - last)) : 1500, signal);
    }
  } finally { ext.driver.send("Page.stopScreencast", {}).catch(() => {}); }
}

async function stream(j, write, signal, busy) {
  if (j.via === "ext") return extStream(j, write, signal, busy);
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
    // the Browser view on your own Chrome (mirror): handled before anything starts the hidden browser
    if (j.via === "ext" && !["/browser/open", "/browser/read", "/browser/act", "/browser/upload", "/browser/download"].includes(p)) { const r = await extHandle(p, j); if (r) return [200, r]; }
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
    if (p === "/browser/ext") { ext.listen(B.note); return [200, await ext.handle(j)]; }
    // the Agent set to "My Chrome": the same reading, clicking, file insertion and downloads, in your Chrome through the extension
    if (j.via === "ext" && (p === "/browser/open" || p === "/browser/read" || p === "/browser/act" || p === "/browser/upload" || p === "/browser/download")) {
      const D = ext.driver;
      if (p === "/browser/open") { const u = fixUrl(j.url); if (!u) return [400, { error: "That address can't be opened here." }]; await D.open(u); await settle(10000, D); return [200, await readPage(D)]; }
      if (p === "/browser/read") return [200, await readPage(D)];
      if (p === "/browser/upload") { const r = await uploadFile(j, D); return [200, { ...r, page: await readPage(D) }]; }
      if (p === "/browser/download") { const r = await downloadFromBrowser(j, D); return [200, { ...r, page: await readPage(D) }]; }
      const r = await act(j, D); return [200, { ...r, page: await readPage(D) }];
    }
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
    if (p === "/browser/search") return [200, await searchIn(pcD, (u) => newTab(u), j.query)];
    if (p === "/browser/open") { const u = fixUrl(j.url); if (!u) return [400, { error: "That address can't be opened here." }]; await send("Page.navigate", { url: u }, cur()); await settle(); return [200, await readPage()]; }
    if (p === "/browser/read") return [200, await readPage()];
    if (p === "/browser/upload") { const r = await uploadFile(j); return [200, { ...r, page: await readPage() }]; }
    if (p === "/browser/download") { const r = await downloadFromBrowser(j); return [200, { ...r, page: await readPage() }]; }
    if (p === "/browser/act") { const r = await act(j); return [200, { ...r, page: await readPage() }]; }
    if (p === "/browser/dialog") { const s = cur(); await send("Page.handleJavaScriptDialog", { accept: !!j.accept, promptText: j.text != null ? String(j.text) : undefined }, s); B.dialog = null; wake(); return [200, state()]; }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown browser request" }];
}

module.exports = { handle, stream, listenExtension: (note) => ext.listen(note) };
