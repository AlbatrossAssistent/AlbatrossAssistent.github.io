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
// the data channel go to the host's /pc/desk (the same mouse and keyboard as the old way), mouse moves only the newest one.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { session } = require("electron");

function create({ BrowserWindow, screen, desktopCapturer, ipcMain, assetsDir, host = "http://127.0.0.1:4747", log = () => {} }) {
  const DIR = path.join(process.env.LOCALAPPDATA || "", "Albatross"), INFO = path.join(DIR, "rtc.json");
  const token = crypto.randomBytes(24).toString("hex");
  let win = null, cur = null;          // the capture window and the session in it: { screen, id }

  // the hidden window's own session: it may capture the screen (nothing else may), and nothing it does touches the app's
  const ses = session.fromPartition("albatross-rtc");
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  ses.setPermissionCheckHandler((_wc, perm) => perm === "media");

  function stop(why) {
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
    cur = { screen: o.screen, id };
    win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { session: ses, preload: path.join(assetsDir, "rtc-preload.js"), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
    win.on("closed", () => { if (cur && cur.id === id) { win = null; cur = null; } });
    await win.loadFile(path.join(assetsDir, "rtc.html"));
    const phys = screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    const maxW = Math.min(phys.width, Math.max(640, Number(o.maxW) || 1920)), maxH = Math.round(maxW * phys.height / phys.width);
    const fps = Math.max(5, Math.min(60, Number(o.fps) || 30));
    const sdp = await win.webContents.executeJavaScript(`start(${JSON.stringify({ sdp: String(o.sdp || ""), sourceId: src.id, maxW, maxH, fps, bitrate: Number(o.bitrate) || 0 })})`);
    log("remote desktop video: " + maxW + "x" + maxH + " up to " + fps + " fps");
    // nobody connected within 30 seconds (the other device gave up, or no direct way between the two): close it
    setTimeout(() => { if (cur && cur.id === id && !cur.connected) stop("never connected"); }, 30000);
    return { sdp };
  }

  // ---------- mouse and keyboard from the data channel -> the host's /pc/desk ----------
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
  server.listen(0, "127.0.0.1", () => {
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INFO, JSON.stringify({ port: server.address().port, token, pid: process.pid })); } catch (e) { log("rtc: " + e.message); }
  });
  return { stop, close() { stop(); try { server.close(); } catch {} try { const i = JSON.parse(fs.readFileSync(INFO, "utf8")); if (i.token === token) fs.unlinkSync(INFO); } catch {} } };
}
module.exports = { create };
