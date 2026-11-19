// Help with my screen, in the desktop app. It lives here and not in the host because the host often runs in Windows' background session
// (started at boot), which cannot see your desktop; the app runs in yours.
//   look(opts)       reads the window the user was just using (not Albatross itself): a picture of it, and a numbered list of the things
//                    in it that can be acted on, with their real positions (host/screenlook.ps1)
//   show(items, s)   draws glowing frames with a short label around those things, on top of everything, for s seconds. The overlay
//                    ignores the mouse, so the user clicks through it; items are { n } (a number from the last look) or { x, y, w, h }
//   clear()          takes them away
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const KIND = { Edit: "text field", Hyperlink: "link", MenuItem: "menu item", TabItem: "tab", ListItem: "list item", CheckBox: "checkbox", ComboBox: "dropdown", RadioButton: "option",
  TreeItem: "tree item", SplitButton: "button", DataItem: "row", Text: "text", Custom: "control", Group: "control", Pane: "control", Image: "image", Spinner: "spinner", Slider: "slider", Button: "button" };

function create({ BrowserWindow, screen, scriptDir, assetsDir, log = () => {} }) {
  let lastLook = null, windows = [], timer = 0, fadeTimer = 0;
  const available = () => process.platform === "win32" && fs.existsSync(path.join(scriptDir, "screenlook.ps1"));

  function look(opts = {}) {
    return new Promise((resolve) => {
      if (!available()) return resolve({ error: "Screen help needs the Windows app." });
      const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptDir, "screenlook.ps1")];
      if (opts.window) args.push("-Window", String(opts.window).slice(0, 80));
      execFile("powershell.exe", args, { maxBuffer: 60e6, timeout: 60000, windowsHide: true }, (err, out) => {
        const line = String(out || "").trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
        if (!line) return resolve({ error: err ? "Couldn't look at the screen: " + String(err.message).slice(0, 160) : "Couldn't read the screen." });
        let j; try { j = JSON.parse(line); } catch { return resolve({ error: "Couldn't read the screen." }); }
        if (j.error) return resolve({ error: j.error });
        const elements = (j.elements || []).map((e, i) => ({ n: i + 1, kind: KIND[e.t] || String(e.t || "").toLowerCase(), name: String(e.n || ""), x: e.x, y: e.y, w: e.w, h: e.h, px: e.px, py: e.py, src: e.s || "ui", actions: e.a || "" }));
        lastLook = { at: Date.now(), window: j.window, screen: j.screen, elements };
        const list = elements.map((e) => `${e.n} ${e.kind} '${e.name.replace(/\s+/g, " ").slice(0, 60) || "(no name)"}'${e.src === "ocr" ? " (read from the screen)" : ""}`).join("; ");
        resolve({ ok: true, title: j.window.title, proc: j.window.proc, hwnd: j.window.hwnd || 0, rect: j.window, image: j.image, elements, list });
      });
    });
  }

  // physical screen pixels -> the overlay window of each display, in the DIPs Electron draws in
  function shapesFor(items) {
    const out = [];
    for (const it of items) {
      let r = it;
      if (it.n != null) { const e = lastLook && lastLook.elements.find((x) => x.n === Number(it.n)); if (!e) continue; r = { x: e.x, y: e.y, w: e.w, h: e.h, label: it.label || e.name }; }
      const x = Number(r.x), y = Number(r.y), w = Number(r.w), h = Number(r.h);
      if (![x, y, w, h].every(Number.isFinite) || w < 2 || h < 2) continue;
      out.push({ rect: screen.screenToDipRect(null, { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }), label: String(r.label || it.label || "").replace(/\s+/g, " ").slice(0, 60), n: it.n != null ? Number(it.n) : null });
    }
    return out;
  }
  function clear() {
    clearTimeout(timer); clearTimeout(fadeTimer);
    for (const w of windows) { try { w.destroy(); } catch {} }
    windows = [];
  }
  function show(items, seconds = 25) {
    clear();
    const shapes = shapesFor(Array.isArray(items) ? items.slice(0, 12) : []);
    if (!shapes.length) return { shown: 0 };
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds, mine = shapes.filter((s) => s.rect.x < b.x + b.width && s.rect.x + s.rect.width > b.x && s.rect.y < b.y + b.height && s.rect.y + s.rect.height > b.y)
        .map((s) => ({ x: s.rect.x - b.x, y: s.rect.y - b.y, w: s.rect.width, h: s.rect.height, label: s.label, n: s.n }));
      if (!mine.length) continue;
      const w = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true,
        focusable: false, alwaysOnTop: true, show: false, title: "Albatross overlay", webPreferences: { preload: path.join(assetsDir, "overlay-preload.js"), sandbox: true, contextIsolation: true } });
      w.setAlwaysOnTop(true, "screen-saver");
      w.setIgnoreMouseEvents(true, { forward: false });     // clicks go to whatever is underneath
      w.webContents.once("did-finish-load", () => { try { w.webContents.send("shapes", mine); w.showInactive(); } catch {} });
      w.loadFile(path.join(assetsDir, "overlay.html"));
      windows.push(w);
    }
    const s = Math.max(3, Math.min(120, Number(seconds) || 25));
    fadeTimer = setTimeout(() => { for (const w of windows) try { w.webContents.send("fade"); } catch {} }, Math.max(0, s * 1000 - 1500));
    timer = setTimeout(clear, s * 1000);
    log(`Screen help: pointing at ${shapes.length} thing${shapes.length === 1 ? "" : "s"} for ${s} s`);
    return { shown: shapes.length };
  }
  return { look, show, clear, available, _windows: () => windows, _last: () => lastLook };
}
module.exports = { create };
