// The slowdown warning: a small card in the corner of the screen, in front of every other app, when something keeps slowing Albatross
// down or has stopped it. The host works out what (GET /health, host/health.js); this decides when to show it:
//   - a problem must stay for two checks in a row (about 40 s): a spike is not a warning
//   - "Snooze" hides that problem for an hour, "Turn off" stops all warnings (also in Settings → Help and the tray menu)
//   - it never takes the keyboard focus, so it can't interrupt typing, and it goes away by itself when the problem does
const path = require("path");
const fs = require("fs");

function create({ BrowserWindow, screen, ipcMain, assetsDir, panel, dataDir, showMain = () => {}, quiet = () => false, log = () => {}, every = 20000, needStreak = 2 }) {
  const FILE = path.join(dataDir, "health.json");
  let cfg = { enabled: true, snooze: {} };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch {}
  const save = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cfg)); } catch {} };
  let win = null, loaded = false, timer = 0, streak = {}, shown = [], busy = false;
  const enabled = () => cfg.enabled !== false;

  const visible = (issues) => issues.filter((i) => (streak[i.id] || 0) >= needStreak && !((cfg.snooze[i.id] || 0) > Date.now()));
  function position() {
    if (!win || win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea, [w, h] = win.getSize();
    win.setPosition(Math.round(area.x + area.width - w - 16), Math.round(area.y + area.height - h - 16));
  }
  function hide() { if (win && !win.isDestroyed()) win.destroy(); win = null; loaded = false; shown = []; }
  function push() { if (win && !win.isDestroyed() && loaded) win.webContents.send("issues", shown); }
  function show(list) {
    shown = list;
    if (!win || win.isDestroyed()) {
      loaded = false;
      win = new BrowserWindow({ width: 400, height: 200, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false,
        title: "Albatross warning", webPreferences: { preload: path.join(assetsDir, "health-preload.js"), sandbox: true, contextIsolation: true } });
      win.setAlwaysOnTop(true, "screen-saver");
      win.webContents.once("did-finish-load", () => { loaded = true; push(); position(); win.showInactive(); });
      win.on("closed", () => { win = null; loaded = false; });
      win.loadFile(path.join(assetsDir, "health.html"));
    } else push();
  }
  async function poll() {
    if (busy) return; busy = true;
    try {
      if (!enabled() || quiet()) { hide(); streak = {}; return; }      // quiet mode: Albatross is being worked on (tools/quiet.js)
      let issues = [];
      try {
        const r = await fetch(panel + "/health", { signal: AbortSignal.timeout(8000) });
        // an answer that isn't a health report (an older host without /health says 404) means "no information", not "down"
        issues = r.ok ? ((await r.json().catch(() => ({}))).issues || []) : [];
      } catch { issues = [{ id: "host-down", level: "error", title: "Albatross's host isn't answering", detail: "The part of Albatross that runs on your PC has stopped. Closing and opening Albatross starts it again." }]; }
      const ids = new Set(issues.map((i) => i.id));
      for (const id of Object.keys(streak)) if (!ids.has(id)) delete streak[id];
      for (const i of issues) streak[i.id] = (streak[i.id] || 0) + 1;
      const list = visible(issues);
      if (list.length) { if (!shown.length) log(`Warning shown: ${list.map((i) => i.id).join(", ")}`); show(list); } else if (shown.length) hide();
    } finally { busy = false; }
  }
  ipcMain.on("health-size", (e, h) => { if (win && !win.isDestroyed() && e.sender === win.webContents) { win.setSize(400, Math.max(120, Math.min(560, Math.round(Number(h) || 200)))); position(); } });
  ipcMain.handle("health-action", async (_e, type, id) => {
    if (type === "snooze") { cfg.snooze[id] = Date.now() + 3600e3; save(); const list = visible(shown); if (list.length) show(list); else hide(); return true; }
    if (type === "off") { cfg.enabled = false; save(); hide(); return true; }
    if (type === "open") { showMain(); return true; }
    if (type === "fix") {
      try { const r = await (await fetch(panel + "/agent/health/fix", { method: "POST", body: JSON.stringify({ id }), signal: AbortSignal.timeout(30000) })).json(); log(r.done || r.error || "fixed"); } catch (e) { log("fix failed: " + e.message); }
      for (const k of Object.keys(streak)) streak[k] = 0;     // asked again from scratch: the card only comes back if it is still wrong
      hide(); return true;
    }
    return false;
  });
  ipcMain.handle("health-get", () => enabled());
  ipcMain.handle("health-set", (_e, on) => { cfg.enabled = !!on; if (on) cfg.snooze = {}; save(); if (!on) hide(); return enabled(); });
  return {
    start() { clearInterval(timer); setTimeout(poll, 15000); timer = setInterval(poll, every); timer.unref && timer.unref(); },
    stop() { clearInterval(timer); hide(); },
    enabled, setEnabled(on) { cfg.enabled = !!on; if (on) cfg.snooze = {}; save(); if (!on) hide(); },
    poll, _win: () => win, _shown: () => shown, _streak: () => streak,
  };
}
module.exports = { create };
