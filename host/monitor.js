// The Monitor: shows a picture or a video full screen on this PC's own screen, chosen from the website.
// - What it shows: a picture or video file on this PC (Albatross pictures, received files, your Pictures/Videos/Downloads),
//   one sent from the device, the newest generated picture (follows new ones), a YouTube video, or a web address.
// - How: layout (fit, fill, stretch, original size, background, turn, mirror, zoom) and options (sound, volume, loop, speed,
//   clock, caption, an info corner), plus play / pause / seek for videos.
// - Where: on which display. The window is Chrome or Edge in kiosk mode, opened on the signed-in desktop by desktop.js; it loads
//   http://127.0.0.1:<panel>/monitor (monitor.html), which follows this state live and reports back how far a video is.
// Only files inside those folders are ever served, and only to this PC (the panel only answers 127.0.0.1).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pcDesk = require("./pcdesk");

const HTML = path.join(__dirname, "monitor.html");
const FILES = process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross");
const UP_DIR = path.join(FILES, "Monitor");
const HOME = os.homedir();
const ROOTS = {
  pictures: { label: "Albatross pictures", dir: path.join(FILES, "Pictures") },
  monitor: { label: "Sent to the Monitor", dir: UP_DIR },
  received: { label: "Received files", dir: FILES, flat: true },
  mypictures: { label: "Pictures", dir: path.join(HOME, "Pictures") },
  videos: { label: "Videos", dir: path.join(HOME, "Videos") },
  downloads: { label: "Downloads", dir: path.join(HOME, "Downloads"), flat: true },
};
const IMG = /\.(png|jpe?g|gif|webp|bmp|avif)$/i, VID = /\.(mp4|webm|mkv|mov|m4v|ogv)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", ogv: "video/ogg" };
const kindOf = (f) => (IMG.test(f) ? "image" : VID.test(f) ? "video" : "");

// ---------- the state ----------
const LAYOUT = { fit: "contain", bg: "black", rotate: 0, mirror: false, zoom: 100 };
const OPTS = { mute: false, volume: 80, loop: true, speed: 1, clock: "off", caption: "", captionPos: "bottom", info: false };
const M = {
  v: 1,                                  // goes up with every change the window should see
  srcV: 1,                               // goes up when what is shown changes (the window then loads it again)
  source: { type: "none" },              // file {root, rel, name, kind} | latest {name, rel, kind} | youtube {id, start, url} | url {url, kind} | none
  layout: { ...LAYOUT }, opts: { ...OPTS },
  screen: -1,                            // which display (-1: the main one)
  screens: [], screensAt: 0,
  cmd: null,                             // { seq, at, name, arg }: play, pause, toggle, restart, seek (s), skip (±s)
  playback: null,                        // the window's last report
  opening: 0, lastError: "",
};
const displays = new Set();              // the window's live connections (open = at least one)
let note = () => {};

function push() {
  M.v++;
  const data = `data: ${JSON.stringify(displayState())}\n\n`;
  for (const c of displays) c.write(data);
}
// what the window needs: where to load the picture/video from, and how to show it
function displayState() {
  const s = M.source; let src = { kind: "none" };
  if (s.type === "file" || s.type === "latest") src = { kind: s.kind, url: `/monitor/media?v=${M.srcV}`, name: s.name };
  else if (s.type === "youtube") src = { kind: "youtube", id: s.id, start: s.start || 0, name: "YouTube" };
  else if (s.type === "url") src = { kind: s.kind, url: s.url, name: s.url };
  return { v: M.v, srcV: M.srcV, src, layout: M.layout, opts: M.opts, cmd: M.cmd, screen: screenOf() };
}
function screenOf() {
  const l = M.screens; if (!l.length) return null;
  return l.find((s) => s.i === M.screen) || l.find((s) => s.primary) || l[0];
}
// for the website: everything, plus whether the window is up and how far a video is
function state() {
  const pb = M.playback && Date.now() - M.playback.at < 6000 ? M.playback : null;
  const s = M.source;
  return {
    open: displays.size > 0, opening: !displays.size && Date.now() - M.opening < 25000, error: M.lastError,
    source: s.type === "file" || s.type === "latest" ? { type: s.type, kind: s.kind, name: s.name, root: s.root || "pictures", rel: s.rel, label: ROOTS[s.root || "pictures"]?.label }
      : s.type === "youtube" ? { type: "youtube", kind: "youtube", id: s.id, start: s.start, url: s.url, name: "YouTube video" } : s.type === "url" ? { type: "url", kind: s.kind, url: s.url, name: s.url } : { type: "none" },
    layout: M.layout, opts: M.opts, screen: M.screen, screens: M.screens, playback: pb,
  };
}

// ---------- files ----------
function inside(root, rel) {
  const r = ROOTS[root]; if (!r) return null;
  const f = path.resolve(r.dir, String(rel || ""));
  if (!f.startsWith(path.resolve(r.dir) + path.sep) || !kindOf(f)) return null;
  if (r.flat && path.dirname(f) !== path.resolve(r.dir)) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}
function list(kind) {
  const out = [];
  for (const [root, r] of Object.entries(ROOTS)) {
    const walk = (dir, depth) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length > 1500) return;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!r.flat && depth < 2 && !e.name.startsWith(".") && f !== UP_DIR && path.resolve(f) !== path.resolve(ROOTS.pictures.dir)) walk(f, depth + 1); continue; }
        const k = kindOf(e.name); if (!k || (kind && kind !== k)) continue;
        try { const st = fs.statSync(f); out.push({ root, label: r.label, rel: path.relative(r.dir, f), name: e.name, kind: k, size: st.size, time: st.mtimeMs }); } catch {}
      }
    };
    walk(r.dir, 0);
  }
  return out.sort((a, b) => b.time - a.time).slice(0, 400);
}
function newestPicture() {
  let best = null;
  try { for (const n of fs.readdirSync(ROOTS.pictures.dir)) { if (!IMG.test(n)) continue; const t = fs.statSync(path.join(ROOTS.pictures.dir, n)).mtimeMs; if (!best || t > best.t) best = { n, t }; } } catch {}
  return best ? best.n : "";
}
// "newest picture" follows new ones while the window is open
setInterval(() => {
  if (M.source.type !== "latest" || !displays.size) return;
  const n = newestPicture();
  if (n && n !== M.source.rel) { M.source = { type: "latest", root: "pictures", rel: n, name: n, kind: "image" }; M.srcV++; push(); }
}, 3000).unref();
function currentFile() {
  const s = M.source;
  return s.type === "file" || s.type === "latest" ? inside(s.root || "pictures", s.rel) : null;
}

// ---------- YouTube / web addresses ----------
function youtube(u) {
  let url; try { url = new URL(String(u).trim()); } catch { return null; }
  const h = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  let id = "";
  if (h === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (h === "youtube.com" || h === "youtube-nocookie.com") id = url.searchParams.get("v") || (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1] || "";
  if (!/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get("t") || url.searchParams.get("start") || "";
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  const start = m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
  return { id, start, url: `https://www.youtube.com/watch?v=${id}` };
}

// ---------- the window ----------
async function screens(force) {
  if (!force && M.screens.length && Date.now() - M.screensAt < 60e3) return M.screens;
  try { M.screens = (await pcDesk.call("screens")).screens || []; M.screensAt = Date.now(); } catch (e) { if (!M.screens.length) throw e; }
  return M.screens;
}
async function open(port) {
  await screens(true);
  const s = screenOf();
  M.opening = Date.now(); M.lastError = "";
  try { await pcDesk.call("monopen", { url: `http://127.0.0.1:${port}/monitor`, x: s ? s.x : 0, y: s ? s.y : 0, w: s ? s.w : 1280, h: s ? s.h : 720 }); }
  catch (e) { M.opening = 0; M.lastError = e.message; throw e; }
  note(`Monitor: opened on ${s ? `display ${s.i + 1}${s.name ? ` (${s.name})` : ""}` : "the screen"}`);
}
async function close() {
  M.opening = 0;
  for (const c of displays) { try { c.end(); } catch {} }
  displays.clear();
  await pcDesk.call("monclose");
  note("Monitor: closed");
}

// ---------- the website's requests: GET /pc/monitor (state), POST /pc/monitor { action, ... } ----------
const uploads = new Map();   // id -> { tmp, name, size, got, time }
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
async function handle(method, body, port) {
  if (method === "GET") return [200, state()];
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  const a = String(j.action || "");
  const ensureOpen = async () => { if (!displays.size && Date.now() - M.opening > 25000) await open(port); };

  if (a === "state") return [200, state()];
  if (a === "screens") { await screens(true); return [200, state()]; }
  if (a === "files") return [200, { files: list(j.kind === "image" || j.kind === "video" ? j.kind : ""), roots: Object.fromEntries(Object.entries(ROOTS).map(([k, r]) => [k, { label: r.label, dir: r.dir }])) }];
  if (a === "open") { if (j.screen !== undefined) M.screen = Math.round(num(j.screen, -1, 16, -1)); await open(port); push(); return [200, state()]; }
  if (a === "close") { await close(); return [200, state()]; }
  if (a === "screen") {
    M.screen = Math.round(num(j.screen, -1, 16, -1));
    if (displays.size || Date.now() - M.opening < 25000) await open(port);   // move the window over
    push(); return [200, state()];
  }
  if (a === "show") {
    const s = j.source || {};
    if (s.type === "file") {
      const f = inside(s.root, s.rel); if (!f) return [404, { error: "That file isn't there any more (or isn't a picture or video)." }];
      M.source = { type: "file", root: s.root, rel: path.relative(ROOTS[s.root].dir, f), name: path.basename(f), kind: kindOf(f) };
    } else if (s.type === "latest") {
      const n = newestPicture(); if (!n) return [404, { error: "No generated pictures on the PC yet." }];
      M.source = { type: "latest", root: "pictures", rel: n, name: n, kind: "image" };
    } else if (s.type === "youtube") {
      const y = youtube(s.url); if (!y) return [400, { error: "That isn't a YouTube video link." }];
      M.source = { type: "youtube", ...y };
    } else if (s.type === "url") {
      const u = String(s.url || "").trim();
      if (!/^https?:\/\/[^\s"'<>]+$/i.test(u) || u.length > 2000) return [400, { error: "Only web addresses (http/https) can be shown." }];
      const y = youtube(u); if (y) M.source = { type: "youtube", ...y };
      else M.source = { type: "url", url: u, kind: s.kind === "video" || (s.kind !== "image" && VID.test(new URL(u).pathname)) ? "video" : "image" };
    } else if (s.type === "none") M.source = { type: "none" };
    else return [400, { error: "Unknown source" }];
    M.playback = null; M.cmd = null; M.srcV++;
    push();
    if (M.source.type !== "none" && j.open !== false) await ensureOpen();
    note(`Monitor: showing ${M.source.type === "youtube" ? "a YouTube video" : M.source.type === "none" ? "nothing" : M.source.name || M.source.url}`);
    return [200, state()];
  }
  if (a === "set") {
    const L = j.layout || {}, O = j.opts || {};
    M.layout = {
      fit: pick(L.fit ?? M.layout.fit, ["contain", "cover", "fill", "none"], "contain"),
      bg: pick(L.bg ?? M.layout.bg, ["black", "blur", "white", "gray"], "black"),
      rotate: pick(Number(L.rotate ?? M.layout.rotate), [0, 90, 180, 270], 0),
      mirror: !!(L.mirror ?? M.layout.mirror),
      zoom: Math.round(num(L.zoom ?? M.layout.zoom, 25, 400, 100)),
    };
    M.opts = {
      mute: !!(O.mute ?? M.opts.mute), volume: Math.round(num(O.volume ?? M.opts.volume, 0, 100, 80)), loop: !!(O.loop ?? M.opts.loop),
      speed: num(O.speed ?? M.opts.speed, 0.25, 3, 1), clock: pick(O.clock ?? M.opts.clock, ["off", "tl", "tr", "bl", "br"], "off"),
      caption: String(O.caption ?? M.opts.caption).slice(0, 200), captionPos: pick(O.captionPos ?? M.opts.captionPos, ["top", "bottom"], "bottom"),
      info: !!(O.info ?? M.opts.info),
    };
    if (j.reset) { M.layout = { ...LAYOUT }; M.opts = { ...OPTS }; }
    push(); return [200, state()];
  }
  if (a === "control") {
    const name = pick(String(j.cmd || ""), ["play", "pause", "toggle", "restart", "seek", "skip"], "");
    if (!name) return [400, { error: "Unknown control" }];
    M.cmd = { seq: (M.cmd?.seq || 0) + 1, at: Date.now(), name, arg: num(j.arg, -86400, 86400, 0) };
    push(); return [200, state()];
  }
  // a picture or video from the device, in pieces (base64), saved into Downloads\Albatross\Monitor and shown
  if (a === "upload-start") {
    const name = path.basename(String(j.name || "file")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 160);
    const size = Number(j.size) || 0;
    if (!kindOf(name)) return [400, { error: "Only pictures and videos can be shown." }];
    if (size <= 0 || size > 2 * 1024 ** 3) return [400, { error: "Files up to 2 GB can be sent to the Monitor." }];
    fs.mkdirSync(UP_DIR, { recursive: true });
    const id = crypto.randomBytes(9).toString("base64url");
    uploads.set(id, { tmp: path.join(UP_DIR, `.${id}.part`), name, size, got: 0, time: Date.now() });
    fs.writeFileSync(uploads.get(id).tmp, "");
    return [200, { id }];
  }
  if (a === "upload-chunk") {
    const u = uploads.get(String(j.id)); if (!u) return [404, { error: "That upload is gone" }];
    if (Number(j.offset) !== u.got) return [409, { error: "Out of order", got: u.got }];
    const buf = Buffer.from(String(j.data || ""), "base64");
    if (u.got + buf.length > u.size) return [400, { error: "Too much data" }];
    fs.appendFileSync(u.tmp, buf); u.got += buf.length; u.time = Date.now();
    return [200, { got: u.got }];
  }
  if (a === "upload-end") {
    const u = uploads.get(String(j.id)); if (!u) return [404, { error: "That upload is gone" }];
    uploads.delete(String(j.id));
    if (u.got !== u.size) { try { fs.unlinkSync(u.tmp); } catch {} return [400, { error: "The file didn't arrive completely" }]; }
    const ext = path.extname(u.name), stem = u.name.slice(0, u.name.length - ext.length);
    let f = path.join(UP_DIR, u.name);
    for (let k = 2; fs.existsSync(f); k++) f = path.join(UP_DIR, `${stem} (${k})${ext}`);
    fs.renameSync(u.tmp, f);
    M.source = { type: "file", root: "monitor", rel: path.basename(f), name: path.basename(f), kind: kindOf(f) };
    M.playback = null; M.cmd = null; M.srcV++;
    push();
    if (j.open !== false) await ensureOpen();
    note(`Monitor: showing ${path.basename(f)} from a device`);
    return [200, state()];
  }
  return [400, { error: "Unknown Monitor request" }];
}
setInterval(() => { for (const [id, u] of uploads) if (Date.now() - u.time > 30 * 60e3) { uploads.delete(id); try { fs.unlinkSync(u.tmp); } catch {} } }, 5 * 60e3).unref();

// ---------- the window's own requests (from the panel, 127.0.0.1 only) ----------
// GET /monitor (the page), GET /monitor/events (live state), GET /monitor/media (the file, with ranges for seeking in videos),
// POST /monitor/report (how far a video is)
function serve(req, res) {
  const u = req.url.split("?")[0];
  // only the window itself (or this PC's address bar), never another website open on this PC
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") { res.writeHead(403); res.end(); return true; }
  if (req.method === "GET" && u === "/monitor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    fs.createReadStream(HTML).pipe(res); return true;
  }
  if (req.method === "GET" && u === "/monitor/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(displayState())}\n\n`);
    displays.add(res); M.opening = 0; M.lastError = "";
    req.on("close", () => displays.delete(res));
    return true;
  }
  if (req.method === "GET" && u === "/monitor/media") {
    const f = currentFile();
    if (!f) { res.writeHead(404); res.end(); return true; }
    const size = fs.statSync(f).size, type = MIME[path.extname(f).slice(1).toLowerCase()] || "application/octet-stream";
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && (r[1] || r[2])) {
      let start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2])), end = r[1] && r[2] ? Math.min(size - 1, Number(r[2])) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return true; }
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      fs.createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      fs.createReadStream(f).pipe(res);
    }
    return true;
  }
  if (req.method === "POST" && u === "/monitor/report" && req.headers["x-burrow"] === "1") {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 4000) req.destroy(); });
    req.on("end", () => {
      try { const j = JSON.parse(raw || "{}"); M.playback = { at: Date.now(), playing: !!j.playing, time: Number(j.time) || 0, duration: Number(j.duration) || 0, w: Number(j.w) || 0, h: Number(j.h) || 0, error: String(j.error || "").slice(0, 200), v: Number(j.v) || 0 }; } catch {}
      res.writeHead(204); res.end();
    });
    return true;
  }
  return false;
}
setInterval(() => { for (const c of displays) c.write(": ping\n\n"); }, 20000).unref();

module.exports = { handle, serve, setNote: (fn) => { note = fn; } };
