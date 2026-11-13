// Albatross for Windows: its own app (Electron), not a browser tab.
//  - starts the Albatross host if it isn't running yet (the part that talks to Ollama, your files, mail, the browser ...), using
//    the Node.js that is built into this app, so nothing else has to be installed
//  - installs Ollama by itself the first time if it's missing (models are Ollama's and stay in its folder; you pick them in the app)
//  - shows the app from the host on this PC (http://localhost:4747/app/): works offline, and needs no browser permissions
//  - lives in the tray next to the clock; can start with Windows (then it starts hidden, so the host is ready for your phone)
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

const PANEL = "http://localhost:4747";
const APP_URL = PANEL + "/app/";
const FILES = app.isPackaged ? path.join(process.resourcesPath, "albatross") : path.resolve(__dirname, "..");
const DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "host");
const ICON = path.join(__dirname, "icon.png");
const hidden = process.argv.includes("--hidden");
let win = null, splash = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => show());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = (url, ms = 1500) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => r.status < 500, () => false);
const ollamaUp = () => reachable("http://127.0.0.1:11434/api/version");
const ollamaExe = () => [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe")].find((f) => fs.existsSync(f));

function status(text, pct) { if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${pct == null ? "null" : Number(pct)})`).catch(() => {}); }

// ---------- Ollama: installed the first time, from ollama.com ----------
function download(url, file, onPct) {
  return new Promise((resolve, reject) => {
    const get = (u, hops = 0) => https.get(u, { headers: { "User-Agent": "Albatross-Desktop" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) { res.resume(); return get(new URL(res.headers.location, u).href, hops + 1); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("Download failed (" + res.statusCode + ")")); }
      const total = Number(res.headers["content-length"]) || 0; let got = 0;
      const out = fs.createWriteStream(file);
      res.on("data", (c) => { got += c.length; if (total) onPct(Math.floor(got / total * 100)); });
      res.pipe(out); out.on("finish", () => out.close(resolve)); out.on("error", reject);
    }).on("error", reject);
    get(url);
  });
}
async function ensureOllama() {
  if ((await ollamaUp()) || ollamaExe()) return;
  status("Installing Ollama, the engine your AI runs on…", 0);
  const file = path.join(os.tmpdir(), "OllamaSetup.exe");
  await download("https://ollama.com/download/OllamaSetup.exe", file, (p) => status("Downloading Ollama…", p));
  status("Installing Ollama…", null);
  await new Promise((resolve) => { const p = spawn(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { windowsHide: true }); p.on("exit", resolve); p.on("error", resolve); });
  // Ollama's installer starts its own tray app; the host takes over from here
  for (let i = 0; i < 30 && !ollamaExe(); i++) await sleep(1000);
  if (!ollamaExe()) throw new Error("Ollama couldn't be installed. Install it from ollama.com, then open Albatross again.");
}

// ---------- the host ----------
async function ensureHost() {
  if (await reachable(PANEL + "/")) return;            // already running (started at boot, or by an older install)
  status("Starting Albatross on this PC…", null);
  fs.mkdirSync(DATA, { recursive: true });
  // the host runs on the Node.js inside this app, on its own: closing the window doesn't stop it
  const child = spawn(process.execPath, [path.join(FILES, "host", "background.js")], {
    cwd: FILES, detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ALBATROSS_DATA: DATA, NODE_PATH: path.join(FILES, "node_modules") },
  });
  child.unref();
  for (let i = 0; i < 90; i++) { if (await reachable(PANEL + "/")) return; await sleep(1000); }
  throw new Error("Albatross didn't start on this PC. Its log is in " + DATA);
}

// ---------- windows ----------
function show() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  if (!hidden || app.isReady()) openMain();
}
function openMain() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 520, title: "Albatross", icon: ICON, show: false, backgroundColor: "#ffffff", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.removeMenu();
  win.loadURL(APP_URL);
  win.once("ready-to-show", () => { win.show(); if (splash && !splash.isDestroyed()) splash.close(); });
  // links to other sites open in the normal browser; the app itself stays here
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(PANEL)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(PANEL)) { e.preventDefault(); shell.openExternal(url); } });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });     // closing keeps it in the tray
}
function openSplash() {
  splash = new BrowserWindow({ width: 420, height: 300, frame: false, resizable: false, show: true, icon: ICON, backgroundColor: "#ffffff", webPreferences: { contextIsolation: true } });
  splash.loadFile(path.join(__dirname, "splash.html"));
}
function makeTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Albatross");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open Albatross", click: () => show() },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--hidden"] }); tray.setContextMenu(menu()); } },
    { label: "Control center", click: () => shell.openExternal(PANEL + "/") },
    { type: "separator" },
    { label: "Quit Albatross", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => show());
}

app.whenReady().then(async () => {
  // the microphone (voice) and notifications for the app from this PC; nothing for other sites
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => cb(String(d.requestingUrl || wc.getURL()).startsWith(PANEL) && ["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"].includes(perm)));
  makeTray();
  if (app.isPackaged && !/win-unpacked/i.test(process.execPath) && !app.getLoginItemSettings().openAtLogin && !fs.existsSync(path.join(DATA, ".asked-autostart"))) {
    // first start: start with Windows by default (the host is then ready for your phone); can be switched off in the tray menu
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, ".asked-autostart"), "1");
  }
  if (!hidden) openSplash();
  try {
    await ensureOllama();
    await ensureHost();
    if (!hidden) openMain();
  } catch (e) {
    if (splash && !splash.isDestroyed()) splash.close();
    dialog.showErrorBox("Albatross", e.message || String(e));
  }
});
app.on("window-all-closed", (e) => { /* keep running in the tray */ });
app.on("before-quit", () => { quitting = true; });
