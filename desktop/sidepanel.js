// The side panel ("monitor tool"): Albatross as a narrow panel at the edge of the screen, next to your other apps.
//   - Explain: drag a box or draw a circle around anything on the screen; the AI explains it, or answers your question about it
//   - Control: tell the AI what to do, and it works the mouse and keyboard on your PC, step by step, until it's done (or you stop it)
// The panel takes its strip of the screen like the taskbar does (a Windows "app bar"), so maximized windows end where it starts.
// It talks to the AI through the host on this PC (http://localhost:4747/ollama/...), like the app does.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { clipboard } = require("electron");

const WIDTH = 420;

// ---------- the app bar: Windows keeps that strip of the screen free for the panel ----------
const APPBAR_CS = `
using System; using System.Runtime.InteropServices;
public class AlbBar {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct DATA { public int size; public IntPtr hwnd; public uint msg; public uint edge; public RECT rc; public IntPtr lp; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint m, ref DATA d);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static string Set(long h, int edge, int L, int T, int R, int B, int width) {
    var d = new DATA(); d.size = Marshal.SizeOf(typeof(DATA)); d.hwnd = new IntPtr(h); d.msg = 0x8000 + 77; d.edge = (uint)edge;
    SHAppBarMessage(0, ref d);
    d.rc.T = T; d.rc.B = B; if (edge == 0) { d.rc.L = L; d.rc.R = L + width; } else { d.rc.R = R; d.rc.L = R - width; }
    SHAppBarMessage(2, ref d);
    if (edge == 0) d.rc.R = d.rc.L + width; else d.rc.L = d.rc.R - width;
    SHAppBarMessage(3, ref d);
    return d.rc.L + "," + d.rc.T + "," + d.rc.R + "," + d.rc.B;
  }
  public static void Remove(long h) { var d = new DATA(); d.size = Marshal.SizeOf(typeof(DATA)); d.hwnd = new IntPtr(h); SHAppBarMessage(1, ref d); }
}`;
function appbar(cmd) {
  const script = `$ErrorActionPreference = "Stop"\nAdd-Type -TypeDefinition @'\n${APPBAR_CS}\n'@\n[void][AlbBar]::SetProcessDPIAware()\n${cmd}\n`;
  const file = path.join(os.tmpdir(), "albatross-appbar-" + process.pid + ".ps1");
  return new Promise((ok) => {
    try { fs.writeFileSync(file, "﻿" + script); } catch { return ok(""); }
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true, timeout: 20000 }, (err, out) => ok(err ? "" : String(out).trim()));
  });
}
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); };

function create({ BrowserWindow, screen, ipcMain, desktopCapturer, globalShortcut, assetsDir, panel, dataDir, screenHelp, input, showMain = () => {}, log = () => {} }) {
  const CFG = path.join(dataDir, "sidepanel.json");
  let cfg = { side: "right", reserve: true };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG, "utf8")) }; } catch {}
  const save = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(cfg)); } catch {} };
  let win = null, barOn = false, barHwnd = "", selecting = null, running = false;

  const display = () => (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  function placeFloating(d = display()) {
    if (!win || win.isDestroyed()) return;
    const a = d.workArea;
    win.setBounds({ x: cfg.side === "left" ? a.x : a.x + a.width - WIDTH, y: a.y, width: WIDTH, height: a.height });
  }
  // takes the strip (physical pixels for Windows), then sits exactly where Windows put the bar
  async function reserve() {
    if (!win || win.isDestroyed() || process.platform !== "win32") return;
    const d = display(), b = d.bounds, sf = d.scaleFactor || 1;
    const phys = screen.dipToScreenRect(null, b);
    barHwnd = hwndOf(win);
    const out = await appbar(`[AlbBar]::Set(${barHwnd}, ${cfg.side === "left" ? 0 : 2}, ${phys.x}, ${phys.y}, ${phys.x + phys.width}, ${phys.y + phys.height}, ${Math.round(WIDTH * sf)})`);
    const m = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/m.exec(out);
    if (!m || !win || win.isDestroyed()) { placeFloating(d); return; }
    barOn = true;
    const r = screen.screenToDipRect(null, { x: +m[1], y: +m[2], width: +m[3] - +m[1], height: +m[4] - +m[2] });
    // the bar runs from top to bottom of the display; the taskbar keeps its own strip, so the panel stops above it
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const a = screen.getDisplayMatching(r).workArea;
      win.setBounds({ x: r.x, y: a.y, width: WIDTH, height: a.height });
    }, 350);
  }
  async function release() {
    if (!barOn || !barHwnd) return;
    barOn = false;
    await appbar(`[AlbBar]::Remove(${barHwnd})`);
  }
  function open() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
    win = new BrowserWindow({
      width: WIDTH, height: 800, frame: false, resizable: false, maximizable: false, minimizable: true, fullscreenable: false, skipTaskbar: false, alwaysOnTop: true, show: false,
      title: "Albatross panel", backgroundColor: "#00000000", transparent: false, icon: path.join(assetsDir, "icon.png"),
      webPreferences: { preload: path.join(assetsDir, "sidepanel-preload.js"), sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "floating");
    placeFloating();
    win.loadFile(path.join(assetsDir, "sidepanel.html"));
    win.once("ready-to-show", async () => { win.show(); if (cfg.reserve) await reserve(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) require("electron").shell.openExternal(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => { stopRun(); release(); win = null; });
    // minimized, it gives the strip back; restored, it takes it again
    win.on("minimize", () => release());
    win.on("restore", () => { if (cfg.reserve) reserve(); });
    log("Side panel opened");
  }
  function close() { if (win && !win.isDestroyed()) win.close(); }
  const toggle = () => (win && !win.isDestroyed() && win.isVisible() ? close() : open());
  const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

  // ---------- Explain: pick a part of the screen ----------
  async function select(mode) {
    if (selecting) return null;
    const displays = screen.getAllDisplays();
    // a still picture of every display, at its real resolution, taken before anything is drawn on top
    const maxW = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor))), maxH = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
    let sources = [];
    try { sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: maxW, height: maxH } }); } catch (e) { return { error: "Couldn't take a picture of the screen: " + e.message }; }
    if (!sources.length) return { error: "Couldn't take a picture of the screen." };
    return new Promise((resolve) => {
      const wins = [];
      const end = (result) => {
        if (!selecting) return;
        selecting = null;
        ipcMain.removeListener("select-done", onDone); ipcMain.removeListener("select-cancel", onCancel);
        for (const w of wins) { try { w.destroy(); } catch {} }
        if (win && !win.isDestroyed()) win.showInactive();
        resolve(result);
      };
      const onDone = (e, r) => { if (wins.some((w) => !w.isDestroyed() && w.webContents === e.sender)) end(r); };
      const onCancel = (e) => { if (wins.some((w) => !w.isDestroyed() && w.webContents === e.sender)) end({ cancelled: true }); };
      selecting = { end };
      ipcMain.on("select-done", onDone); ipcMain.on("select-cancel", onCancel);
      displays.forEach((d, i) => {
        const src = sources.find((s) => String(s.display_id) === String(d.id)) || (displays.length === 1 ? sources[0] : sources[i]);
        if (!src) return;
        const b = d.bounds;
        const w = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
          enableLargerThanScreen: true, hasShadow: false, title: "Albatross select", backgroundColor: "#000000",
          webPreferences: { preload: path.join(assetsDir, "select-preload.js"), sandbox: true, contextIsolation: true } });
        w.setAlwaysOnTop(true, "screen-saver");
        w.webContents.once("did-finish-load", () => {
          if (w.isDestroyed()) return;
          w.setBounds(b);
          w.webContents.send("select-start", { mode, image: src.thumbnail.toDataURL() });
          w.show();
          if (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id === d.id) w.focus();
        });
        w.on("closed", () => { if (selecting && wins.every((x) => x.isDestroyed())) end({ cancelled: true }); });
        w.loadFile(path.join(assetsDir, "select.html"));
        wins.push(w);
      });
      if (!wins.length) end({ error: "Couldn't take a picture of the screen." });
    });
  }

  // ---------- the AI, through the host ----------
  const chats = new Map();     // id -> AbortController
  async function models() {
    const r = await fetch(panel + "/ollama/api/tags", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("The AI on this PC isn't answering.");
    const list = ((await r.json()).models || []).map((m) => m.name);
    const caps = await Promise.all(list.map((name) => fetch(panel + "/ollama/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(8000) })
      .then((x) => x.json()).then((j) => j.capabilities || []).catch(() => [])));
    return list.map((name, i) => ({ name, caps: caps[i] })).filter((m) => m.caps.includes("completion") || !m.caps.length);
  }
  // streams an answer to the panel as it comes ("ai-chunk"), and resolves with all of it
  async function chat(id, body) {
    const ac = new AbortController(); chats.set(id, ac);
    try {
      const r = await fetch(panel + "/ollama/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), signal: ac.signal });
      if (!r.ok || !r.body) { let msg = ""; try { msg = (await r.json()).error; } catch {} throw new Error(msg || "The AI didn't answer (" + r.status + ")."); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", content = "", thinking = "", calls = [];
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          const m = j.message || {};
          if (m.thinking) { thinking += m.thinking; send("ai-chunk", id, { thinking: m.thinking }); }
          if (m.content) { content += m.content; send("ai-chunk", id, { content: m.content }); }
          if (m.tool_calls) calls = calls.concat(m.tool_calls);
        }
      }
      return { content, thinking, tool_calls: calls };
    } catch (e) {
      if (ac.signal.aborted) return { content: "", aborted: true };
      return { error: e.message || String(e) };
    } finally { chats.delete(id); }
  }

  // ---------- Control: the AI works the mouse and keyboard ----------
  let last = null;    // the last look: where the window is and how its picture was scaled
  const panelRect = () => (win && !win.isDestroyed() ? screen.dipToScreenRect(null, win.getBounds()) : null);
  // view "window": the window in front (its picture and what can be clicked in it). view "screen": the same list, but the picture
  // is the whole display (taskbar, other windows, notifications), and x, y then mean places in that picture.
  async function look(opts = {}) {
    const r = await screenHelp.look(opts);
    if (opts.view !== "screen") {
      if (r.error) return r;
      last = { rect: r.rect, scale: (r.image && r.image.scale) || 1, hwnd: r.hwnd, elements: r.elements, title: r.title };
      return { ok: true, title: r.title, proc: r.proc, list: r.list, image: r.image, count: r.elements.length, w: r.image && r.image.w, h: r.image && r.image.h };
    }
    const d = r.error ? screen.getPrimaryDisplay() : screen.getDisplayMatching(screen.screenToDipRect(null, { x: r.rect.x, y: r.rect.y, width: Math.max(1, r.rect.w), height: Math.max(1, r.rect.h) }));
    const phys = screen.dipToScreenRect(null, d.bounds);
    const tw = Math.min(1600, phys.width), th = Math.round(tw * phys.height / phys.width);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: tw, height: th } });
    const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
    if (!src) return { error: "Couldn't take a picture of the screen." };
    const img = src.thumbnail, size = img.getSize();
    last = { rect: { x: phys.x, y: phys.y, w: phys.width, h: phys.height }, scale: size.width / phys.width, hwnd: r.error ? 0 : r.hwnd, elements: r.error ? [] : r.elements, title: r.error ? "" : r.title };
    return { ok: true, view: "screen", title: r.error ? "(the desktop)" : r.title, proc: r.error ? "" : r.proc, list: r.error ? "" : r.list, count: r.error ? 0 : r.elements.length,
      image: { b64: img.toJPEG(80).toString("base64"), w: size.width, h: size.height }, w: size.width, h: size.height };
  }
  // the open windows (title, program, handle), for "which windows are open" and switching between them
  function windows() {
    const ps = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { '' + [int64]$_.MainWindowHandle + '|' + $_.ProcessName + '|' + $_.MainWindowTitle }";
    return new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + ps], { windowsHide: true, timeout: 15000, maxBuffer: 4e6 }, (err, out) => {
      ok(String(out || "").split(/\r?\n/).map((l) => l.trim().split("|")).filter((x) => x.length >= 3 && Number(x[0]))
        .map(([h, proc, ...t]) => ({ hwnd: Number(h), proc, title: t.join("|") })).filter((w) => !/^Albatross (panel|select|overlay|warning)$/.test(w.title)));
    }));
  }
  // a command in PowerShell, as you would type it; the panel always asks you first. Its output goes back to the AI.
  function runCommand(cmd) {
    return new Promise((ok) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + cmd], { windowsHide: true, timeout: 120000, maxBuffer: 8e6, cwd: os.homedir() }, (err, out, errOut) => {
      const text = (String(out || "") + (errOut ? "\n" + String(errOut) : "")).trim();
      ok({ code: err ? (err.killed ? "timeout" : err.code ?? 1) : 0, text: text.length > 6000 ? text.slice(0, 3000) + "\n…\n" + text.slice(-3000) : text });
    }));
  }
  // where on the real screen: a thing from the last look (its click point), or a point in the last picture
  function pointFor(a) {
    if (!last) throw new Error("Look at the screen first.");
    if (a.n != null && a.n !== "") {
      const e = last.elements.find((x) => x.n === Number(a.n)); if (!e) throw new Error(`There is no number ${a.n} in the last look.`);
      return { x: Number.isFinite(e.px) ? e.px : e.x + e.w / 2, y: Number.isFinite(e.py) ? e.py : e.y + e.h / 2, what: `${e.kind} '${String(e.name).slice(0, 40)}'` };
    }
    const x = Number(a.x), y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Say which thing (n) or where (x, y in the picture).");
    return { x: last.rect.x + x / last.scale, y: last.rect.y + y / last.scale, what: `the point ${Math.round(x)}, ${Math.round(y)}` };
  }
  function guard(p) {
    const r = panelRect();
    if (r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height) throw new Error("That point is on the Albatross panel itself; I don't click there.");
  }
  // ---------- moving the mouse yourself stops the AI ----------
  // While it works, the cursor should only move where the AI put it. Every 80 ms the cursor is compared with that spot; if it
  // wandered off by more than a few pixels, that was you, and the AI stops at once. While the AI moves the mouse itself (a click
  // or scroll in progress) and while it waits for your answer in the panel, nothing is checked.
  const watch = { timer: 0, base: null, acting: false, paused: false };
  const cursor = () => screen.getCursorScreenPoint();
  function watchStart() {
    clearInterval(watch.timer);
    watch.base = cursor(); watch.acting = false; watch.paused = false;
    watch.timer = setInterval(() => {
      if (!running || watch.acting || watch.paused || !watch.base) return;
      const p = cursor();
      if (Math.hypot(p.x - watch.base.x, p.y - watch.base.y) > 6) { log("Side panel: you moved the mouse, the AI stopped"); stopRun("mouse"); }
    }, 80);
  }
  const watchStop = () => { clearInterval(watch.timer); watch.timer = 0; watch.base = null; };
  // the AI moved the cursor to p (physical pixels): that is where it should stay until the next move
  const movedTo = (p) => { watch.base = screen.screenToDipPoint({ x: Math.round(p.x), y: Math.round(p.y) }); };
  async function moving(p, fn) {
    watch.acting = true;
    try { await fn(); } finally { movedTo(p); watch.acting = false; }
  }
  async function act(a) {
    if (!running) throw new Error("Stopped.");
    const kind = String(a.action || "");
    if (kind === "click" || kind === "double_click" || kind === "right_click") {
      const p = pointFor(a); guard(p);
      await moving(p, () => input.click(p.x, p.y, kind === "right_click" ? "right" : "left", kind === "double_click" ? 2 : 1));
      return `${kind.replace("_", " ")} on ${p.what}`;
    }
    if (kind === "scroll") {
      const p = a.n != null || a.x != null ? pointFor(a) : last ? { x: last.rect.x + last.rect.w / 2, y: last.rect.y + last.rect.h / 2, what: "the window" } : null;
      if (!p) throw new Error("Look at the screen first."); guard(p);
      const amt = (String(a.direction) === "up" ? 1 : -1) * Math.max(1, Math.min(15, Number(a.amount) || 5));
      await moving(p, () => input.scroll(p.x, p.y, amt));
      return `scrolled ${amt > 0 ? "up" : "down"} on ${p.what}`;
    }
    if (kind === "type") {
      if (last && last.hwnd) await input.focus(last.hwnd);
      await input.type(String(a.text || ""));
      if (a.enter) await input.keys("enter");
      return `typed "${String(a.text || "").slice(0, 60)}"${a.enter ? " and pressed Enter" : ""}`;
    }
    if (kind === "keys") {
      if (last && last.hwnd && !/^win|alt\+tab/i.test(String(a.keys))) await input.focus(last.hwnd);
      await input.keys(String(a.keys || ""));
      return `pressed ${a.keys}`;
    }
    if (kind === "open") {
      const t = String(a.target || "").trim(); if (!t) throw new Error("Say what to open.");
      if (/^https?:\/\//i.test(t)) { await require("electron").shell.openExternal(t); return `opened ${t}`; }
      // a program by name: the Start menu finds it, like typing it there yourself
      await input.keys("win"); await new Promise((r) => setTimeout(r, 700));
      await input.type(t); await new Promise((r) => setTimeout(r, 900));
      await input.keys("enter");
      return `opened ${t} from the Start menu`;
    }
    if (kind === "move") {
      const p = pointFor(a); guard(p);
      await moving(p, () => input.move(p.x, p.y));
      return `moved the mouse over ${p.what}`;
    }
    if (kind === "drag") {
      const from = pointFor({ n: a.from_n, x: a.from_x, y: a.from_y }), to = pointFor({ n: a.to_n, x: a.to_x, y: a.to_y });
      guard(from); guard(to);
      await moving(to, () => input.drag(from.x, from.y, to.x, to.y, a.button === "right" ? "right" : "left"));
      return `dragged from ${from.what} to ${to.what}`;
    }
    if (kind === "hold_keys") {
      if (last && last.hwnd) await input.focus(last.hwnd);
      await input.hold(String(a.keys || ""), a.seconds);
      return `held ${a.keys} for ${Math.max(0.05, Math.min(10, Number(a.seconds) || 1))} s`;
    }
    if (kind === "clipboard_read") { const t = clipboard.readText(); return t ? `the clipboard holds: ${t.length > 4000 ? t.slice(0, 4000) + "…" : t}` : "the clipboard has no text"; }
    if (kind === "clipboard_write") { clipboard.writeText(String(a.text || "")); return `put ${String(a.text || "").length} characters on the clipboard`; }
    if (kind === "list_windows") {
      const list = await windows();
      return list.length ? "open windows: " + list.map((w) => `"${w.title.slice(0, 80)}" (${w.proc})`).join("; ") : "no windows are open";
    }
    if (kind === "switch_window") {
      const q = String(a.name || "").toLowerCase(); if (!q) throw new Error("Say which window.");
      const w = (await windows()).find((x) => x.title.toLowerCase().includes(q) || x.proc.toLowerCase().includes(q));
      if (!w) throw new Error(`No open window matches "${a.name}". Use list_windows to see them.`);
      await input.focus(w.hwnd);
      return `switched to "${w.title.slice(0, 80)}"`;
    }
    if (kind === "run_command") {
      const c = String(a.command || "").trim(); if (!c) throw new Error("Say which command.");
      log("Side panel: the AI runs a command (allowed by you)");
      const r = await runCommand(c);
      return `ran the command (exit ${r.code}). Output:\n${r.text || "(nothing)"}`;
    }
    throw new Error(`"${kind}" isn't something I can do.`);
  }
  function stopRun(reason) {
    if (!running) return;
    running = false;
    watchStop();
    try { globalShortcut.unregister("CommandOrControl+Alt+X"); } catch {}
    for (const ac of chats.values()) ac.abort();
    if (win && !win.isDestroyed()) win.setFocusable(true);
    send("control-stopped", reason || "");
  }

  ipcMain.handle("panel-models", async () => { try { return { models: await models() }; } catch (e) { return { error: e.message }; } });
  ipcMain.handle("panel-chat", (_e, id, body) => chat(String(id), body || {}));
  ipcMain.handle("panel-abort", (_e, id) => { const ac = chats.get(String(id)); if (ac) ac.abort(); return true; });
  ipcMain.handle("panel-select", async (_e, mode) => select(mode === "lasso" ? "lasso" : "box"));
  ipcMain.handle("panel-config", (_e, change) => {
    if (change && typeof change === "object") {
      const before = { ...cfg };
      if (change.side === "left" || change.side === "right") cfg.side = change.side;
      if (typeof change.reserve === "boolean") cfg.reserve = change.reserve;
      save();
      if (before.side !== cfg.side || before.reserve !== cfg.reserve) (async () => { await release(); if (cfg.reserve) await reserve(); else placeFloating(); })();
    }
    return { ...cfg, desktop: screenHelp.available() };
  });
  ipcMain.handle("panel-window", (_e, what) => { if (!win || win.isDestroyed()) return; if (what === "close") close(); else if (what === "minimize") win.minimize(); else if (what === "app") showMain();
    // answering the AI's question needs the keyboard for a moment, even while it works
    else if (what === "focus") { win.setFocusable(true); win.focus(); } else if (what === "nofocus" && running) win.setFocusable(false); });
  ipcMain.handle("control-start", () => {
    if (!screenHelp.available()) return { error: "Controlling the PC needs the Albatross app for Windows." };
    running = true;
    try { globalShortcut.register("CommandOrControl+Alt+X", () => stopRun("keys")); } catch {}
    // while the AI works, the panel never takes the keyboard: what it types goes to the app it works in, not here
    if (win && !win.isDestroyed()) win.setFocusable(false);
    watchStart();
    log("Side panel: the AI is controlling the PC");
    return { ok: true };
  });
  ipcMain.handle("control-stop", () => { stopRun(); return true; });
  // the panel waits for your Allow or answer: you need the mouse for that, so it doesn't count as "stop" meanwhile
  ipcMain.handle("control-watch", (_e, on) => { watch.paused = !on; if (on) watch.base = cursor(); return true; });
  ipcMain.handle("control-look", async (_e, opts) => { if (!running) return { error: "Stopped." }; try { return await look(opts || {}); } catch (e) { return { error: e.message }; } });
  ipcMain.handle("control-act", async (_e, a) => { try { return { done: await act(a || {}) }; } catch (e) { return { error: e.message }; } });
  ipcMain.handle("control-point", async (_e, items) => screenHelp.show(items || [], 4));

  return { open, close, toggle, isOpen: () => !!(win && !win.isDestroyed()), release, stop: stopRun };
}
module.exports = { create };
