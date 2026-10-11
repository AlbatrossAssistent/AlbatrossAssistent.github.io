// Files between the website and this PC.
// - Devices with the full code send files here (end-to-end encrypted, like the chats). They land in RECEIVED.
// - Files you put in OUTBOX (from the control center) can be downloaded by those devices.
// Only devices with the full code can reach this, because every request is decrypted with the code's key first.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const RECEIVED = process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross");
const OUTBOX = path.join(RECEIVED, "Send to devices");
const MAX_FILE = 4 * 1024 ** 3;        // 4 GB per file
const MAX_CHUNK = 8 * 1024 * 1024;     // per request

const KEEP = 48 * 3600e3;  // half-finished uploads wait this long for their sender to come back
const uploads = new Map(); // id -> { name, size, got, tmp, fd, time }
const finished = new Map(); // id -> { saved, time }, so a lost "done" answer can be repeated
const received = [];       // newest first, for the control center

function ensureDirs() { fs.mkdirSync(OUTBOX, { recursive: true }); }

// Keep only a plain file name: no folders, no characters Windows can't store.
function safeName(n) {
  const base = path.basename(String(n || "file")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base) || !base ? "file_" + base : base;
}
// "photo.jpg" -> "photo (2).jpg" if it already exists
function freePath(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && !d.name.endsWith(".albatross-part"))
      .map((d) => { const st = fs.statSync(path.join(dir, d.name)); return { name: d.name, size: st.size, time: st.mtimeMs }; })
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
}
// Drop half-finished uploads that nobody continued for two days (the website keeps sending after the tab is closed,
// or picks up again the next time it's opened, so they have to be kept for a while).
function sweep() {
  for (const [id, u] of uploads) if (Date.now() - u.time > KEEP) { try { fs.closeSync(u.fd); fs.unlinkSync(u.tmp); } catch {} uploads.delete(id); }
  for (const [id, f] of finished) if (Date.now() - f.time > 3600e3) finished.delete(id);
  try {
    for (const d of fs.readdirSync(RECEIVED, { withFileTypes: true })) {
      if (!d.isFile() || !d.name.endsWith(".albatross-part")) continue;
      const f = path.join(RECEIVED, d.name);
      if (!uploads.has(d.name.slice(0, -14)) && Date.now() - fs.statSync(f).mtimeMs > KEEP) fs.unlinkSync(f);
    }
  } catch {}
}
setInterval(sweep, 600e3).unref();
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Requests from the website, already decrypted. Returns [status, json].
function handle(method, p, body, note) {
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch {}
  ensureDirs();
  if (method === "GET" && p === "/files/list") return [200, { outbox: listDir(OUTBOX) }];

  if (method === "POST" && p === "/files/upload-start") {
    const size = Number(j.size);
    if (!(size >= 0) || size > MAX_FILE) return [400, { error: "Files can be up to 4 GB." }];
    const name = safeName(j.name);
    // The sender picks the id, so it can ask again after a break and continue where the PC stopped.
    const id = ID_RE.test(String(j.tid || "")) ? String(j.tid).toLowerCase() : crypto.randomUUID();
    if (finished.has(id)) return [200, { id, got: size, done: true, saved: finished.get(id).saved }];
    const known = uploads.get(id);
    if (known) { known.time = Date.now(); return [200, { id, got: known.got }]; }
    const tmp = path.join(RECEIVED, id + ".albatross-part");
    let got = 0;
    try { got = Math.min(size, fs.statSync(tmp).size); } catch {}     // left over from before a restart of the host
    const fd = fs.openSync(tmp, got ? "r+" : "w");
    uploads.set(id, { name, size, got, tmp, fd, time: Date.now() });
    return [200, { id, got }];
  }
  if (method === "POST" && p === "/files/upload-chunk") {
    const u = uploads.get(j.id);
    if (!u) return [404, { error: "Upload not found (it may have timed out). Send the file again." }];
    const offset = Number(j.offset);
    if (offset !== u.got) return [409, { error: "Out of order", got: u.got }];
    const data = Buffer.from(String(j.data || ""), "base64");
    if (data.length > MAX_CHUNK || u.got + data.length > u.size) return [400, { error: "Chunk too large" }];
    fs.writeSync(u.fd, data, 0, data.length, u.got);
    u.got += data.length; u.time = Date.now();
    return [200, { got: u.got }];
  }
  if (method === "POST" && p === "/files/upload-end") {
    const u = uploads.get(j.id);
    if (!u && finished.has(j.id)) return [200, { saved: finished.get(j.id).saved }];
    if (!u) return [404, { error: "Upload not found" }];
    uploads.delete(j.id);
    fs.closeSync(u.fd);
    if (u.got !== u.size) { fs.unlinkSync(u.tmp); return [400, { error: "The file arrived incomplete. Send it again." }]; }
    const dest = freePath(RECEIVED, u.name);
    fs.renameSync(u.tmp, dest);
    finished.set(j.id, { saved: path.basename(dest), time: Date.now() });
    received.unshift({ name: path.basename(dest), size: u.size, time: Date.now() });
    received.length = Math.min(received.length, 30);
    note(`Received a file: ${path.basename(dest)} (${(u.size / 1e6).toFixed(1)} MB)`);
    return [200, { saved: path.basename(dest) }];
  }
  if (method === "POST" && p === "/files/upload-cancel") {
    const u = uploads.get(j.id);
    if (u) { uploads.delete(j.id); try { fs.closeSync(u.fd); fs.unlinkSync(u.tmp); } catch {} }
    return [200, { ok: true }];
  }
  if (method === "POST" && p === "/files/download") {
    const name = safeName(j.name);
    const file = path.join(OUTBOX, name);
    if (!fs.existsSync(file)) return [404, { error: "That file isn't offered anymore." }];
    const size = fs.statSync(file).size;
    const offset = Math.max(0, Number(j.offset) || 0);
    const len = Math.min(MAX_CHUNK / 2, Math.max(0, size - offset));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    if (offset + len >= size) note(`A device downloaded ${name}`);
    return [200, { size, data: buf.toString("base64") }];
  }
  return [404, { error: "Unknown files request" }];
}

// ---------- for the control center (only reachable from this PC) ----------
function state() { ensureDirs(); return { folder: RECEIVED, outboxFolder: OUTBOX, received: received.length ? received : listDir(RECEIVED).slice(0, 30), outbox: listDir(OUTBOX) }; }

// Streams an upload from the control center into the outbox.
function saveToOutbox(rawName, req) {
  ensureDirs();
  return new Promise((resolve, reject) => {
    const dest = freePath(OUTBOX, safeName(rawName));
    const tmp = dest + ".albatross-part";
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_FILE) { req.destroy(); out.destroy(); fs.unlink(tmp, () => {}); reject(new Error("Files can be up to 4 GB.")); } });
    req.pipe(out);
    out.on("finish", () => { fs.renameSync(tmp, dest); resolve({ name: path.basename(dest), size }); });
    out.on("error", reject);
  });
}
function removeFromOutbox(name) { const f = path.join(OUTBOX, safeName(name)); if (fs.existsSync(f)) fs.unlinkSync(f); return { ok: true }; }
function receivedPath(name) { const f = path.join(RECEIVED, safeName(name)); return fs.existsSync(f) ? f : null; }

module.exports = { handle, state, saveToOutbox, removeFromOutbox, receivedPath };
