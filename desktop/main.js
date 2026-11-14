// Albatross for Windows: its own app (Electron), not a browser tab.
//  - starts the Albatross host if it isn't running yet (the part that talks to Ollama, your files, mail, the browser ...), using
//    the Node.js that is built into this app, so nothing else has to be installed
//  - installs Ollama by itself the first time if it's missing (models are Ollama's and stay in its folder; you pick them in the app)
//  - shows the app from the host on this PC (http://localhost:4747/app/): works offline, and needs no browser permissions
//  - lives in the tray next to the clock; can start with Windows (then it starts hidden, so the host is ready for your phone)
//  - can make the host start when the PC boots, before anyone signs in (control center → Start at boot)
//  - updates itself: new versions come from GitHub, download in the background and install when the app restarts
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, dialog, ipcMain, Notification } = require("electron");
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
const hidden = process.argv.includes("--hidden");
let win = null, splash = null, tray = null, quitting = false, update = null;     // update: { version, ready }

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
function installUpdate() { if (!autoUpdater || !(update && update.ready)) return; quitting = true; autoUpdater.quitAndInstall(true, true); }
function startUpdates() {
  if (!autoUpdater || !app.isPackaged || /win-unpacked/i.test(process.execPath)) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  const tell = () => { if (win && !win.isDestroyed()) win.webContents.send("update", update); makeTray.refresh && makeTray.refresh(); };
  autoUpdater.on("update-available", (i) => { update = { version: i.version, ready: false }; tell(); });
  autoUpdater.on("update-downloaded", (i) => {
    update = { version: i.version, ready: true }; tell();
    if (Notification.isSupported()) { const n = new Notification({ title: "Albatross " + i.version + " is ready", body: "Click to restart Albatross now, or it updates the next time it starts." }); n.on("click", installUpdate); n.show(); }
  });
  autoUpdater.on("error", () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 20000); setInterval(check, 4 * 3600e3);
}
// ---------- Google sign-in ----------
// Google refuses sign-in inside app windows, and the pop-up can't talk back to the app from the normal browser. So the app opens
// a small one-time page on http://localhost:<port> in your normal browser (localhost is allowed to sign in with Firebase); you sign
// in with Google there and the page hands Google's token back to this app only (a random state, the page's own origin), then the
// app signs in with it. The page keeps nothing: in-memory sign-in, and the little server closes right after.
let googleWait = null;
function googleSignIn(config) {
  if (googleWait) { shell.openExternal(googleWait.url); return googleWait.promise; }
  const http = require("http");
  const state = require("crypto").randomBytes(24).toString("hex");
  const page = (port) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Albatross · Sign in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f8;color:#111}main{text-align:center;max-width:360px;padding:24px}
button{font:inherit;font-weight:600;padding:12px 22px;border-radius:999px;border:1px solid #ccc;background:#fff;cursor:pointer}p{color:#555}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#222;color:#eee;border-color:#444}p{color:#aaa}}</style></head>
<body><main><h2>Sign in to Albatross</h2><p id="t">Continue with Google here; Albatross on this PC signs in by itself.</p><button id="b">Continue with Google</button></main>
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
const auth = initializeAuth(initializeApp(${JSON.stringify(config)}), { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
const t = document.getElementById("t"), b = document.getElementById("b");
b.onclick = async () => {
  b.disabled = true; t.textContent = "Signing in…";
  try {
    const r = await signInWithPopup(auth, new GoogleAuthProvider());
    const c = GoogleAuthProvider.credentialFromResult(r);
    const res = await fetch("/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: ${JSON.stringify(state)}, idToken: c.idToken, accessToken: c.accessToken }) });
    if (!res.ok) throw new Error("Albatross didn't take it (" + res.status + "). Start the sign-in again in the app.");
    b.hidden = true; t.textContent = "Done: you're signed in to Albatross. You can close this tab.";
  } catch (e) { b.disabled = false; t.textContent = e.code === "auth/popup-closed-by-user" ? "The Google window was closed. Try again." : (e.message || String(e)); }
};
</script></body></html>`;
  let done, fail;
  const promise = new Promise((res, rej) => { done = res; fail = rej; });
  const server = http.createServer((req, res) => {
    const origin = "http://localhost:" + server.address().port;
    if (req.method === "GET" && req.url.split("?")[0] === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.end(page(server.address().port));
    }
    if (req.method === "POST" && req.url === "/done" && req.headers.origin === origin) {
      let body = ""; req.on("data", (c) => { body += c; if (body.length > 64e3) req.destroy(); });
      return req.on("end", () => {
        let j = {}; try { j = JSON.parse(body); } catch {}
        if (j.state !== state || !j.idToken) { res.writeHead(403); return res.end(); }
        res.writeHead(204); res.end();
        finish(); done({ idToken: j.idToken, accessToken: j.accessToken || null });
        show();
      });
    }
    res.writeHead(404); res.end();
  });
  const timer = setTimeout(() => { finish(); fail(new Error("Sign-in timed out. Try again.")); }, 10 * 60e3);
  function finish() { clearTimeout(timer); googleWait = null; setTimeout(() => server.close(), 1000); }
  server.on("error", (e) => { finish(); fail(e); });
  server.listen(0, "127.0.0.1", () => {
    const url = "http://localhost:" + server.address().port + "/";
    googleWait = { url, promise }; shell.openExternal(url);
  });
  return promise;
}
ipcMain.handle("google-signin", async (_e, config) => { try { return await googleSignIn(config); } catch (e) { return { error: e.message || String(e) }; } });

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
