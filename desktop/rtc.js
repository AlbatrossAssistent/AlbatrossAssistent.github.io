// Remote desktop as live video, the way Chrome Remote Desktop does it: the screen goes to the other device over WebRTC, directly
// between the two (no server in between once connected), as video (VP8/VP9/H.264, often hardware-encoded: after the first picture
// only what changed travels), with the mouse and keyboard coming back over a data channel of the same connection.
// The old way (JPEG pictures through the Albatross server, host/remotedesk.js) stays as the fallback, for when the two can't reach
// each other directly or this app isn't open.
//
// The connection is set up through the host (POST /pc/rtc, end-to-end encrypted with your code like everything else): the host
// hands the other device's offer to this app through a small server on 127.0.0.1 (port and a secret in %LOCALAPPDATA%\Albatross\
// rtc.json, which only your Windows account can read), and passes the answer back. WebRTC encrypts the video itself (DTLS-SRTP),
// and the keys it checks come inside that encrypted offer and answer, so the Albatross server can't see or change the picture.
//
// The screen is captured in a hidden window (rtc.html) in this app, where Chromium's screen capture and video encoder are. Inputs from
// the data channel go straight to this app's own copy of the remote-desktop PowerShell (host/remotedesk.ps1: the same mouse and keyboard
// as the old way, without the trip through the host and the desktop helper); if that can't start, to the host's /pc/desk.
// Fingers from a phone or tablet become Windows touch input there (as Chrome Remote Desktop does): Windows hides the mouse pointer
// while you touch, so it isn't in the video.
// "Hide the PC's monitor": the PC's monitors show a cover screen (cover.html) while the video still shows the desktop under it.
// During a session HDR is switched off (an HDR desktop blooms and looks washed out in the video), and the PC's own mouse pointer is
// hidden while the other device uses a mouse or the cover is on (the other device shows its own pointer); both come back 5 seconds
// after the session (a new session right after, for another quality or screen, doesn't flicker them).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");
const { session } = require("electron");

function create({ BrowserWindow, screen, desktopCapturer, ipcMain, globalShortcut = null, assetsDir, scriptDir, host = "http://127.0.0.1:4747", infoFile = "", log = () => {} }) {
  const INFO = infoFile || path.join(process.env.LOCALAPPDATA || "", "Albatross", "rtc.json"), DIR = path.dirname(INFO);     // tests pass their own file
  const token = crypto.randomBytes(24).toString("hex");
  let win = null, cur = null;          // the capture window and the session in it: { screen, id }

  // the hidden window's own session: it may capture the screen (nothing else may), and nothing it does touches the app's
  const ses = session.fromPartition("albatross-rtc");
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  ses.setPermissionCheckHandler((_wc, perm) => perm === "media");

  function stop(why) {
    coverLater(); restoreLater();
    if (win && !win.isDestroyed()) win.destroy();
    if (cur) log("remote desktop video ended" + (why ? " (" + why + ")" : ""));
    win = null; cur = null;
  }
  // which of Windows' screens the host means (it sends that screen's place in physical pixels)
  function displayFor(rect) {
    const all = screen.getAllDisplays();
    if (!rect) return screen.getPrimaryDisplay();
    let best = all[0], score = Infinity;
    for (const d of all) {
      const p = screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
      const s = Math.abs(p.x - rect.x) + Math.abs(p.y - rect.y) + Math.abs(p.width - rect.w) + Math.abs(p.height - rect.h);
      if (s < score) { score = s; best = d; }
    }
    return best;
  }
  async function offer(o) {
    stop("a new one");
    const d = displayFor(o.rect);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src) throw new Error("No screen to show");
    const id = Date.now();
    cur = { screen: o.screen, id, rect: o.rect && o.rect.w > 0 ? o.rect : null };
    // the mouse and keyboard's PowerShell starts now, not at the first click (starting it takes a second or two); HDR goes off before
    // the capture starts, so the video starts with the right colours
    if (psStart()) { psKeep(); clearTimeout(restoreT); restoreT = 0; await psAsk("hdr", { off: true }, 6000).then((r) => { if (r && r.changed) { hdrOff = true; log("remote desktop: HDR off on " + r.changed + " monitor(s)"); } }, () => {}); }
    win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { session: ses, preload: path.join(assetsDir, "rtc-preload.js"), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
    win.on("closed", () => { if (cur && cur.id === id) { win = null; cur = null; } });
    await win.loadFile(path.join(assetsDir, "rtc.html"));
    const phys = screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    const maxW = Math.min(phys.width, Math.max(640, Number(o.maxW) || 1920)), maxH = Math.round(maxW * phys.height / phys.width);
    // up to 120 frames a second (the most Chromium's screen capture gives), but never more than the monitor shows: a 60 Hz
    // monitor has nothing new between its own 60 pictures
    const hz = Math.round(Number(d.displayFrequency) || 60), top = Math.max(60, Math.min(120, hz));
    const fps = Math.max(5, Math.min(top, Number(o.fps) || 30));
    const sdp = await win.webContents.executeJavaScript(`start(${JSON.stringify({ sdp: String(o.sdp || ""), sourceId: src.id, maxW, maxH, fps, hz, bitrate: Number(o.bitrate) || 0 })})`);
    log("remote desktop video: " + maxW + "x" + maxH + " up to " + fps + " fps (monitor " + hz + " Hz)");
    // nobody connected within 30 seconds (the other device gave up, or no direct way between the two): close it
    setTimeout(() => { if (cur && cur.id === id && !cur.connected) stop("never connected"); }, 30000);
    return { sdp };
  }

  // ---------- the cover: the PC's monitors show a cover screen, the video doesn't ----------
  // Windows leaves a window out of every screen capture when asked (setContentProtection: WDA_EXCLUDEFROMCAPTURE, Windows 10 2004
  // and later), so whoever is at the PC sees the cover while the video shows the desktop under it. Clicks, touches and keys go
  // through it (it can't be clicked or focused). It goes when you switch it off, 5 seconds after the session ends (so the new session
  // after changing the quality or the screen doesn't uncover it in between), or with Ctrl+Alt+Shift+U on the PC.
  // Windows forgets the exclusion when a window is first shown (measured: set before showing, the window was in the capture), so it's
  // set after showing, and again every second along with putting the cover back on top of windows that came up since.
  let hdrOff = false, ptrHidden = false, restoreT = 0;
  function pointer(hide) { if (hide === ptrHidden || !psStart()) return; ptrHidden = hide; psWrite("pointer", { hide }); }
  function restoreNow() {
    clearTimeout(restoreT); restoreT = 0;
    if (ptrHidden && !covers.length) pointer(false);
    if (hdrOff && ps) { hdrOff = false; psWrite("hdr", { off: false }); log("remote desktop: HDR back on"); }
  }
  function restoreLater() { clearTimeout(restoreT); restoreT = setTimeout(restoreNow, 5000); }
  let covers = [], coverOff = 0, coverTick = 0;
  const COVER_KEY = "CommandOrControl+Alt+Shift+U";
  function coverOn() {
    clearTimeout(coverOff); coverOff = 0;
    if (covers.length) return;
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds;
      const w = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true,
        alwaysOnTop: true, hasShadow: false, backgroundColor: "#000000", title: "Albatross: in use remotely", webPreferences: { sandbox: true, contextIsolation: true } });
      w.setAlwaysOnTop(true, "screen-saver");
      w.setIgnoreMouseEvents(true, { forward: false });
      w.loadFile(path.join(assetsDir, "cover.html")).catch(() => {});
      w.showInactive(); w.setBounds(b);
      w.setContentProtection(true);
      setTimeout(() => { if (!w.isDestroyed()) w.setContentProtection(true); }, 100);
      covers.push(w);
    }
    coverTick = setInterval(() => covers.forEach((w) => { if (!w.isDestroyed()) { w.setContentProtection(true); w.moveTop(); } }), 1000);
    // the keys at the PC: the cover goes, and the pointer comes back for whoever sits there (even while the other device uses a mouse)
    try { if (globalShortcut) globalShortcut.register(COVER_KEY, () => { if (cur) cur.mouse = false; coverDrop(); pointer(false); }); } catch {}
    pointer(true);         // the pointer would show on top of the cover
    log("remote desktop: the PC's monitors show the cover");
  }
  function coverDrop() {
    clearTimeout(coverOff); coverOff = 0; clearInterval(coverTick); coverTick = 0;
    if (!covers.length) return;
    for (const w of covers) try { if (!w.isDestroyed()) w.destroy(); } catch {}
    covers = [];
    try { if (globalShortcut) globalShortcut.unregister(COVER_KEY); } catch {}
    if (!cur || !cur.mouse) pointer(false);
    log("remote desktop: the cover is gone");
  }
  function coverLater() { if (covers.length && !coverOff) coverOff = setTimeout(coverDrop, 5000); }

  // ---------- mouse and keyboard from the data channel ----------
  // this app's own remotedesk.ps1: one line per input, answered in order; a mouse move waits only while two are unanswered (then
  // only the newest one goes)
  let ps = null, psBuf = "", pending = 0, moveHeld = null, touchHeld = null, psIdle = 0, seqNo = 0;
  let vkOf = null; try { vkOf = require(path.join(scriptDir, "remotedesk.js")).vkOf; } catch {}
  function psStart() {
    if (ps && ps.exitCode === null && !ps.killed) return ps;
    if (!scriptDir || !vkOf) return null;
    try {
      ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptDir, "remotedesk.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch { ps = null; return null; }
    pending = 0; psBuf = "";
    ps.stdout.setEncoding("utf8");
    ps.stdout.on("data", (d) => {
      psBuf += d; let k;
      while ((k = psBuf.indexOf("\n")) >= 0) { const line = psBuf.slice(0, k); psBuf = psBuf.slice(k + 1); if (line.startsWith("@@") && !line.startsWith("@@ready")) { const m = /^@@(\d+) (.*)$/.exec(line), w = m && asks.get(m[1]); if (w) { asks.delete(m[1]); try { w(JSON.parse(m[2])); } catch { w(null); } } if (line.includes('"via":"mouse"')) noTouch(); pending = Math.max(0, pending - 1); if (moveHeld && pending < 2) { const m = moveHeld; moveHeld = null; psWrite("move", m); } if (touchHeld && pending < 2) { const t = touchHeld; touchHeld = null; psWrite("touch", { pts: t }); } } }
    });
    ps.on("exit", () => { ps = null; pending = 0; });
    ps.on("error", () => { ps = null; });
    return ps;
  }
  function psWrite(cmd, arg) {
    if (!psStart()) return false;
    psKeep();
    pending++; ps.stdin.write(JSON.stringify({ id: ++seqNo, cmd, arg }) + "\n");
    return seqNo;
  }
  // a command whose answer is needed (HDR off before the capture starts)
  const asks = new Map();
  function psAsk(cmd, arg, ms) {
    const id = psWrite(cmd, arg); if (!id) return Promise.reject(new Error("no PowerShell"));
    return new Promise((ok, no) => { const t = setTimeout(() => { asks.delete(String(id)); no(new Error("timeout")); }, ms); asks.set(String(id), (r) => { clearTimeout(t); ok(r); }); });
  }
  // Windows didn't take a finger as touch input: the other device goes back to imitating the mouse with touch (tap, long press,
  // two fingers to scroll), which it can do better than the first finger as the mouse here
  function noTouch() {
    if (!cur || cur.noTouch || !win || win.isDestroyed()) return;
    cur.noTouch = true; log("remote desktop: touch input refused, using the mouse");
    win.webContents.executeJavaScript('say({ t: "hello", touch: false })').catch(() => {});
  }
  // unused for 5 minutes: closed
  function psKeep() { clearTimeout(psIdle); psIdle = setTimeout(() => (cur || covers.length || hdrOff || ptrHidden ? psKeep() : psEnd()), 5 * 60e3); }
  // ended by closing its input: then it shows the pointer and switches HDR back on before it goes (killed, it couldn't)
  function psEnd() { const p = ps; if (!p) return; try { p.stdin.end(); } catch {} setTimeout(() => { try { if (p.exitCode === null) p.kill(); } catch {} }, 4000); }
  // a place in the picture (0..1) -> the screen's pixel
  const px = (o) => { const r = cur.rect, fx = Math.max(0, Math.min(1, Number(o.x) || 0)), fy = Math.max(0, Math.min(1, Number(o.y) || 0)); return { x: Math.round(r.x + fx * (r.w - 1)), y: Math.round(r.y + fy * (r.h - 1)) }; };
  function direct(o) {
    if (!cur.rect || !vkOf) return false;
    const button = ["left", "right", "middle"].includes(o.button) ? o.button : "left";
    if (o.t === "move") { const p = px(o); if (pending >= 2 && ps) { moveHeld = p; return true; } return psWrite("move", p); }
    if (o.t === "down" || o.t === "up") return psWrite(o.t, { ...px(o), button });
    if (o.t === "click") return psWrite("click", { ...px(o), button, count: Math.max(1, Math.min(3, Number(o.count) || 1)) });
    if (o.t === "wheel") return psWrite("wheel", { ...px(o), dy: Math.max(-2400, Math.min(2400, Math.round(Number(o.dy) || 0))), horizontal: !!o.horizontal });
    if (o.t === "key") { const vk = vkOf(o.code || o.key); return vk ? psWrite("key", { vk, down: !!o.down }) : true; }
    if (o.t === "combo") { const vks = String(o.combo || "").split("+").map((x) => vkOf(x.trim())).filter(Boolean).slice(0, 4); return vks.length ? psWrite("combo", { vks }) : true; }
    if (o.t === "text") return psWrite("text", { text: String(o.text || "").slice(0, 2000) });
    // fingers (s: 0 down, 1 moved, 2 up), every finger that's down in each frame; a frame of only moves may wait (then only the
    // newest goes), a finger going down or up never does, and no older move comes after it
    if (o.t === "touch") {
      const pts = (Array.isArray(o.pts) ? o.pts : []).slice(0, 10).map((c) => ({ id: Math.max(0, Math.min(9, Math.floor(Number(c.id) || 0))), ...px(c), s: c.s === "down" ? 0 : c.s === "up" ? 2 : 1 }));
      if (!pts.length) return true;
      if (pts.every((c) => c.s === 1) && pending >= 2 && ps) { touchHeld = pts; return true; }
      touchHeld = null;
      return psWrite("touch", { pts });
    }
    return true;
  }
  // the fallback: the host's /pc/desk, one after the other, mouse moves only the newest one
  let queue = Promise.resolve(), moveNext = null, moveWaiting = false;
  const desk = (o) => fetch(host + "/pc/desk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o), signal: AbortSignal.timeout(15000) }).catch(() => {});
  ipcMain.on("rtc-state", (e, s) => {
    if (!win || e.sender !== win.webContents || !cur) return;
    if (s === "connected") { cur.connected = true; log("remote desktop video connected"); }
    if (s === "closed" || s === "failed") stop(s);
  });
  ipcMain.on("rtc-input", (e, raw) => {
    if (!win || e.sender !== win.webContents || !cur) return;
    let o; try { o = JSON.parse(raw); } catch { return; }
    if (!o || typeof o.t !== "string") return;
    if (o.t === "bye") return stop("closed on the other device");
    if (o.t === "cover") return o.on ? coverOn() : coverDrop();
    if (o.t === "pointer") { cur.mouse = !!o.hide; return pointer(!!o.hide || covers.length > 0); }
    if (direct(o)) return;
    if (o.t === "touch") {      // no way to touch directly: the finger that changed (or the first) as the mouse, through the host
      const pts = Array.isArray(o.pts) ? o.pts : [], f = pts.find((c) => c && c.s !== "move") || pts[0];
      if (!f) return;
      o = { t: f.s === "down" ? "down" : f.s === "up" ? "up" : "move", button: "left", x: f.x, y: f.y };
    }
    const msg = { ...o, screen: cur.screen };
    if (o.t === "move") {
      moveNext = msg; if (moveWaiting) return;
      moveWaiting = true;
      queue = queue.then(() => { moveWaiting = false; const m = moveNext; moveNext = null; return m && desk(m); });
      return;
    }
    queue = queue.then(() => desk(msg));
  });

  // ---------- the little server the host talks to ----------
  const server = http.createServer((req, res) => {
    const done = (st, j) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method !== "POST" || req.headers["x-token"] !== token) return done(403, { error: "no" });
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on("end", async () => {
      let o = {}; try { o = JSON.parse(body || "{}"); } catch {}
      try {
        if (req.url === "/offer") return done(200, await offer(o));
        if (req.url === "/stop") { stop("stopped"); return done(200, { ok: true }); }
        done(404, { error: "unknown" });
      } catch (e) { stop("error"); done(500, { error: e.message || String(e) }); }
    });
  });
  // the host finds this server through rtc.json; if it goes missing or another copy wrote its own there (a second start, a test),
  // it's written again within 10 seconds, or live video would quietly fall back to the slow pictures
  const writeInfo = () => {
    if (!server.listening) return;
    try { const i = JSON.parse(fs.readFileSync(INFO, "utf8")); if (i.token === token && i.port === server.address().port) return; } catch {}
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INFO, JSON.stringify({ port: server.address().port, token, pid: process.pid })); } catch (e) { log("rtc: " + e.message); }
  };
  server.listen(0, "127.0.0.1", writeInfo);
  const keep = setInterval(writeInfo, 10000); keep.unref && keep.unref();
  return { stop, close() { clearInterval(keep); stop(); coverDrop(); restoreNow(); psEnd(); try { server.close(); } catch {} try { const i = JSON.parse(fs.readFileSync(INFO, "utf8")); if (i.token === token) fs.unlinkSync(INFO); } catch {} } };
}
module.exports = { create };
