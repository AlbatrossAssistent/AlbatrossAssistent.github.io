// Albatross for Windows: its own app (Electron), not a browser tab.
//  - starts the Albatross host if it isn't running yet (the part that talks to Ollama, your files, mail, the browser ...), using
//    the Node.js that is built into this app, so nothing else has to be installed
//  - installs Ollama by itself the first time if it's missing (models are Ollama's and stay in its folder; you pick them in the app)
//  - shows the app from the host on this PC (http://localhost:4747/app/): works offline, and needs no browser permissions
//  - lives in the tray next to the clock; can start with Windows (then it starts hidden, so the host is ready for your phone)
//  - can make the host start when the PC boots, before anyone signs in (control center → Start at boot)
//  - updates itself: new versions come from GitHub, download in the background and install when the app restarts
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, nativeTheme, dialog, ipcMain, Notification } = require("electron");
const { execFile } = require("child_process");
let autoUpdater = null; try { autoUpdater = require("electron-updater").autoUpdater; } catch {}
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
// hidden: started with Windows (or came back from a quiet update in the tray): no window, only the tray
const HIDDEN_MARK = path.join(DATA, ".relaunch-hidden");
let hidden = process.argv.includes("--hidden");
try { if (fs.existsSync(HIDDEN_MARK)) { fs.unlinkSync(HIDDEN_MARK); hidden = true; } } catch {}
let win = null, splash = null, splashReady = null, tray = null, quitting = false, update = null, starting = true;     // update: { version, ready }

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => show());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = (url, ms = 1500) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => r.status < 500, () => false);
const ollamaUp = () => reachable("http://127.0.0.1:11434/api/version");
const ollamaExe = () => [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe")].find((f) => fs.existsSync(f));

// the opening / updating screen (splash.html): calls wait until it has loaded, and keep their order
function splashJs(code) {
  if (!splash || splash.isDestroyed()) return;
  const w = splash;
  splashReady.then(() => { if (!w.isDestroyed()) w.webContents.executeJavaScript(code).catch(() => {}); });
}
const status = (text, pct) => splashJs(`setStatus(${JSON.stringify(text)}, ${pct == null ? "null" : Number(pct)})`);
const step = (id, state) => splashJs(`setStep(${JSON.stringify(id)}, ${JSON.stringify(state)})`);

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
// start-host.cmd: how the boot task (and anyone) starts the host with this app's Node; rewritten at every start so it follows
// the app after updates
const START_CMD = path.join(DATA, "start-host.cmd");
function writeStartCmd() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(START_CMD, ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `set "ALBATROSS_DATA=${DATA}"`, `cd /d "${FILES}"`, `"${process.execPath}" "${path.join(FILES, "host", "background.js")}"`, ""].join("\r\n"));
}
const taskExists = () => new Promise((r) => execFile("schtasks", ["/Query", "/TN", "Burrow host"], { windowsHide: true }, (err) => r(!err)));
// control center → Start at boot: the scheduled task is made with admin rights (Windows asks) and your password (Windows asks)
async function setBootStart(on) {
  if (!app.isPackaged) return { error: "Only in the installed app." };
  writeStartCmd();
  const ps1 = path.join(FILES, "host", "autostart-app.ps1");
  const inner = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}" ${on ? "install" : "uninstall"} -Cmd "${START_CMD}" -WorkDir "${FILES}"`;
  const code = await new Promise((r) => execFile("powershell.exe", ["-NoProfile", "-Command", `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '${inner.replace(/'/g, "''")}'; exit $p.ExitCode } catch { exit 3 }`], { windowsHide: true }, (err) => r(err ? (err.code ?? 1) : 0)));
  const now = await taskExists();
  if (on && !now) {
    let why = code === 3 ? "Windows' admin question was declined." : code === 2 ? "The password was cancelled." : "";
    try { why = why || fs.readFileSync(path.join(os.tmpdir(), "albatross-autostart-error.txt"), "utf8").trim(); } catch {}
    return { error: "Start at boot wasn't turned on" + (why ? ": " + why : ".") };
  }
  return { on: now };
}
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
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true, preload: path.join(__dirname, "preload.js") },
  });
  win.removeMenu();
  win.loadURL(APP_URL);
  win.once("ready-to-show", () => { win.show(); if (splash && !splash.isDestroyed()) splash.close(); });
  // links to other sites open in the normal browser; the app itself stays here
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(PANEL)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(PANEL)) { e.preventDefault(); shell.openExternal(url); } });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });     // closing keeps it in the tray
  // an update that's ready installs quietly once the window has been in the tray for a minute
  win.on("hide", () => { if (update && update.ready && !quitting) setTimeout(() => { if (update && update.ready && !quitting && win && !win.isDestroyed() && !win.isVisible()) installUpdate({ hidden: true }); }, 60e3); });
}
function openSplash() {
  splash = new BrowserWindow({ width: 480, height: 340, frame: false, resizable: false, maximizable: false, show: true, center: true, icon: ICON, title: "Albatross", backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff", webPreferences: { contextIsolation: true, sandbox: true } });
  splashReady = new Promise((r) => splash.webContents.once("did-finish-load", r));
  splash.loadFile(path.join(__dirname, "splash.html"));
  // the version at the bottom; "just updated" the first time a new version starts
  let last = ""; try { last = fs.readFileSync(LAST_VER, "utf8").trim(); } catch {}
  splashJs(`setVersion(${JSON.stringify("Version " + app.getVersion() + (last && last !== app.getVersion() ? " · just updated" : ""))})`);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(LAST_VER, app.getVersion()); } catch {}
}
// the updating screen: the same window, in its "update" look; the main window steps aside
function showUpdating(text, pct) {
  if (!splash || splash.isDestroyed()) openSplash();
  if (win && !win.isDestroyed()) win.hide();
  splash.show();
  splashJs(`setMode("update", "Updating Albatross")`);
  splashJs(`setVersion(${JSON.stringify("Version " + app.getVersion() + (update ? " → " + update.version : ""))})`);
  status(text, pct);
}
function makeTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Albatross");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open Albatross", click: () => show() },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--hidden"] }); tray.setContextMenu(menu()); } },
    { label: "Control center", click: () => { show(); setTimeout(() => win && win.webContents.executeJavaScript("window.openControlCenter && openControlCenter()").catch(() => {}), 400); } },
    ...(update && update.ready ? [{ label: "Restart to update (" + update.version + ")", click: () => installUpdate() }] : []),
    { type: "separator" },
    { label: "Quit Albatross", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => show());
  makeTray.refresh = () => tray.setContextMenu(menu());
}

// ---------- updates (GitHub releases of AlbatrossAssistent.github.io) ----------
// - at every start Albatross first looks for a new version (a few seconds at most); if there is one, it downloads and installs right
//   there on the updating screen, and opens again by itself
// - while it runs, it looks every 4 hours; a new version downloads in the background. In the tray it installs quietly (and comes back
//   in the tray); with the window open it waits for "Restart to update", or until the window is closed to the tray
const LAST_VER = path.join(DATA, ".last-version");
const canUpdate = () => !!autoUpdater && app.isPackaged && !/win-unpacked/i.test(process.execPath);
function installUpdate(opts = {}) {
  if (!canUpdate() || !(update && update.ready) || installUpdate.busy) return;
  installUpdate.busy = true; quitting = true;
  if (opts.hidden) { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(HIDDEN_MARK, "1"); } catch {} }
  else showUpdating("Installing version " + update.version + "… Albatross opens again by itself.", null);
  setTimeout(() => autoUpdater.quitAndInstall(true, true), opts.hidden ? 0 : 1200);
}
function updateAtStart() {
  if (!canUpdate()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let found = false, timer = 0;
    const end = (v) => { clearTimeout(timer); for (const [e, fn] of on) autoUpdater.removeListener(e, fn); resolve(v); };
    const on = [
      ["update-not-available", () => end(false)],
      ["error", () => end(false)],
      ["update-available", (i) => {
        found = true; clearTimeout(timer); update = { version: i.version, ready: false };
        if (!hidden) showUpdating("A new version (" + i.version + ") is here. Downloading…", 0);
        timer = setTimeout(() => end(false), 10 * 60e3);
      }],
      ["download-progress", (p) => { if (!hidden && update) status("Downloading version " + update.version + "… " + Math.round(p.percent) + "%", p.percent); }],
      ["update-downloaded", (i) => { update = { version: i.version, ready: true }; end(true); }],
    ];
    for (const [e, fn] of on) autoUpdater.on(e, fn);
    timer = setTimeout(() => { if (!found) end(false); }, 8000);
    autoUpdater.checkForUpdates().catch(() => end(false));
  });
}
function startUpdates() {
  if (!canUpdate()) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  const tell = () => { if (win && !win.isDestroyed()) win.webContents.send("update", update); makeTray.refresh && makeTray.refresh(); };
  autoUpdater.on("update-available", (i) => { if (!update || update.version !== i.version) update = { version: i.version, ready: false }; tell(); });
  autoUpdater.on("update-downloaded", (i) => {
    update = { version: i.version, ready: true }; tell();
    if (starting) return;                                   // the start takes care of it (updating screen)
    if (!win || win.isDestroyed() || !win.isVisible()) return installUpdate({ hidden: true });    // in the tray: right away, quietly
    if (Notification.isSupported()) { const n = new Notification({ title: "Albatross " + i.version + " is ready", body: "Click to update now (takes a few seconds), or it updates when you close the window." }); n.on("click", () => installUpdate()); n.show(); }
  });
  autoUpdater.on("error", () => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600e3);
}
ipcMain.handle("version", () => ({ app: app.getVersion(), update }));
ipcMain.handle("boot", (_e, on) => setBootStart(on));
ipcMain.handle("update-check", async () => { if (!autoUpdater || !app.isPackaged) return { error: "Updates work in the installed app." }; try { const r = await autoUpdater.checkForUpdates(); return { latest: r && r.updateInfo && r.updateInfo.version, current: app.getVersion(), update }; } catch (e) { return { error: e.message }; } });
ipcMain.handle("update-install", () => { installUpdate(); return { ok: !!(update && update.ready) }; });

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
  if (app.isPackaged) writeStartCmd();
  startUpdates();
  step("update", "active"); status("Looking for a new version…");
  const fresh = await updateAtStart();
  starting = false;
  if (fresh) return installUpdate({ hidden });
  step("update", canUpdate() ? "done" : "skip");
  try {
    step("ollama", "active"); status("Checking Ollama…");
    await ensureOllama();
    step("ollama", "done"); step("host", "active"); status("Connecting to Albatross on this PC…");
    await ensureHost();
    step("host", "done");
    if (!hidden) { step("open", "active"); status("Opening…"); openMain(); }
  } catch (e) {
    if (splash && !splash.isDestroyed()) splash.close();
    dialog.showErrorBox("Albatross", e.message || String(e));
  }
});
app.on("window-all-closed", (e) => { /* keep running in the tray */ });
app.on("before-quit", () => { quitting = true; });
