// Beam between the devices that use this PC: a phone sends a file to the laptop (or the other way round) through the PC.
// The file is kept here until the device it is for opens Albatross; that device then sees it, saves it and it is
// deleted here. So the other device doesn't have to be online when you send.
// It also remembers which devices use the PC (kept on disk, so they still show after a restart).
// Everything arrives here already decrypted by host.js (or from the website on this PC itself), like every /pc/ request.
//
// Requests (all POST, body JSON with "me": { id, name, kind } = the device that asks):
//   /pc/dropstart  { to, name, size }      -> { id }
//   /pc/dropchunk  { id, offset, data }    -> { got }          (data: base64, up to 2 MB)
//   /pc/dropend    { id }                  -> { ok, online }   (online: is the other device online right now)
//   /pc/dropcancel { id }                  -> { ok }           (the sender stops it, or the receiver declines it)
//   /pc/dropinbox  {}                      -> { inbox: [...], sent: [...] }
//   /pc/dropget    { id, offset }          -> { size, data }
//   /pc/droptaken  { id }                  -> { ok }           (the receiver saved it: delete it here)
//   /pc/forgetdevice { id }                -> { ok }

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(process.env.ALBATROSS_FILES || path.join(os.homedir(), "Downloads", "Albatross"), ".beam");
const INDEX = path.join(DIR, "index.json");
const DEVICES = path.join(DIR, "devices.json");
const MAX_FILE = 2 * 1024 ** 3;          // 2 GB per file
const MAX_TOTAL = 20 * 1024 ** 3;        // all waiting files together
const MAX_CHUNK = 2 * 1024 * 1024;
const KEEP = 30 * 24 * 3600e3;           // a file waits this long for its device
const KEEP_LOG = 7 * 24 * 3600e3;        // the sender sees "delivered" for a week
const ONLINE = 2 * 60e3;                 // seen in the last 2 minutes = online (open pages ask every 20 s)

let items = [];                          // { id, from: {id,name,kind}, to, toName, name, size, got, time, state: "up"|"ready"|"taken"|"declined", done }
const devices = new Map();               // id -> { id, name, kind, first, last, requests, local }

function load() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  try { items = JSON.parse(fs.readFileSync(INDEX, "utf8")).items || []; } catch { items = []; }
  try { for (const d of JSON.parse(fs.readFileSync(DEVICES, "utf8")).devices || []) devices.set(d.id, d); } catch {}
  sweep();
}
let saveT = 0, saveDevT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(INDEX, JSON.stringify({ items })); } catch {} }, 300); }
function saveDevices() { clearTimeout(saveDevT); saveDevT = setTimeout(() => { try { fs.writeFileSync(DEVICES, JSON.stringify({ devices: [...devices.values()] })); } catch {} }, 1500); }
const fileOf = (id) => path.join(DIR, id + ".bin");
function drop(it) { try { fs.unlinkSync(fileOf(it.id)); } catch {} }
function sweep() {
  const now = Date.now();
  items = items.filter((it) => {
    if ((it.state === "up" || it.state === "ready") && now - it.time > KEEP) { drop(it); return false; }
    if ((it.state === "taken" || it.state === "declined") && now - (it.done || it.time) > KEEP_LOG) return false;
    return true;
  });
  // files with no entry (a crash in the middle)
  try { for (const f of fs.readdirSync(DIR)) if (f.endsWith(".bin") && !items.some((it) => it.id + ".bin" === f)) fs.unlinkSync(path.join(DIR, f)); } catch {}
  save();
}
setInterval(sweep, 3600e3).unref();

const ID_RE = /^[\w-]{6,64}$/;
// a device was seen (every request from the website, see host.js); local: the website on this PC itself
function see(d, local) {
  if (!d || typeof d.id !== "string" || !ID_RE.test(d.id)) return null;
  const now = Date.now(), name = String(d.name || "Device").replace(/[\u0000-\u001f<>]/g, "").slice(0, 40) || "Device", kind = /^(phone|tablet|computer)$/.test(d.kind) ? d.kind : "computer";
  let x = devices.get(d.id);
  const isNew = !x;
  if (x) { x.last = now; x.requests++; x.name = name; x.kind = kind; if (local) x.local = true; }
  else devices.set(d.id, (x = { id: d.id, name, kind, first: now, last: now, requests: 1, local: !!local }));
  saveDevices();
  return isNew ? x : null;
}
const online = (id) => { const d = devices.get(id); return !!d && Date.now() - d.last < ONLINE; };
function list() { return [...devices.values()].sort((a, b) => b.last - a.last).map((d) => ({ ...d, online: online(d.id) })); }
const waitingBytes = () => items.filter((it) => it.state === "up" || it.state === "ready").reduce((n, it) => n + it.size, 0);

function safeName(n) {
  const base = path.basename(String(n || "file")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return base || "file";
}

function handle(method, p, body, note) {
  if (method !== "POST") return [405, { error: "Use POST" }];
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  const me = j.me && ID_RE.test(String(j.me.id || "")) ? j.me : null;
  if (!me) return [400, { error: "This page is too old for Beam between devices. Reload it." }];
  see(me);
  const it = typeof j.id === "string" ? items.find((x) => x.id === j.id) : null;

  if (p === "/pc/dropinbox") {
    const inbox = items.filter((x) => x.to === me.id && x.state === "ready").map((x) => ({ id: x.id, from: x.from, name: x.name, size: x.size, time: x.time }));
    const sent = items.filter((x) => x.from.id === me.id).sort((a, b) => b.time - a.time).slice(0, 30)
      .map((x) => ({ id: x.id, to: x.to, toName: devices.get(x.to)?.name || x.toName, name: x.name, size: x.size, got: x.got, time: x.time, state: x.state, done: x.done || 0, online: online(x.to) }));
    return [200, { inbox, sent }];
  }
  if (p === "/pc/dropstart") {
    const to = String(j.to || ""), size = Math.floor(Number(j.size));
    if (!devices.has(to)) return [404, { error: "That device isn't known to this PC anymore." }];
    if (to === me.id) return [400, { error: "That's this device." }];
    if (!(size >= 0) || size > MAX_FILE) return [400, { error: "Files can be up to 2 GB." }];
    if (waitingBytes() + size > MAX_TOTAL) return [507, { error: "Too many files are waiting on the PC (20 GB). They clear when the other devices pick them up." }];
    const x = { id: crypto.randomUUID(), from: { id: me.id, name: String(me.name || "Device").slice(0, 40), kind: me.kind }, to, toName: devices.get(to).name, name: safeName(j.name), size, got: 0, time: Date.now(), state: "up" };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileOf(x.id), "");
    items.push(x); save();
    return [200, { id: x.id }];
  }
  if (!it) return [404, { error: "That file isn't on the PC anymore." }];
  const mine = it.from.id === me.id, forMe = it.to === me.id;

  if (p === "/pc/dropchunk") {
    if (!mine || it.state !== "up") return [409, { error: "This file can't take more data." }];
    const offset = Number(j.offset), data = Buffer.from(String(j.data || ""), "base64");
    if (offset !== it.got) return [200, { got: it.got }];            // a repeat or a gap: the sender continues from here
    if (data.length > MAX_CHUNK || it.got + data.length > it.size) return [400, { error: "Too much data" }];
    fs.appendFileSync(fileOf(it.id), data);
    it.got += data.length; it.time = Date.now(); save();
    return [200, { got: it.got }];
  }
  if (p === "/pc/dropend") {
    if (!mine) return [403, { error: "Not yours" }];
    if (it.state === "up") {
      if (it.got !== it.size) return [409, { error: "The file isn't complete yet", got: it.got }];
      it.state = "ready"; it.time = Date.now(); save();
      note(`Beam: ${it.from.name} left ${it.name} for ${it.toName}`);
    }
    return [200, { ok: true, online: online(it.to) }];
  }
  if (p === "/pc/dropcancel") {
    if (!mine && !forMe) return [403, { error: "Not yours" }];
    drop(it);
    if (forMe && it.state === "ready") { it.state = "declined"; it.done = Date.now(); }
    else items = items.filter((x) => x !== it);
    save();
    return [200, { ok: true }];
  }
  if (p === "/pc/dropget") {
    if (!forMe || it.state !== "ready") return [404, { error: "That file isn't waiting for this device." }];
    const offset = Math.max(0, Number(j.offset) || 0), len = Math.min(MAX_CHUNK, Math.max(0, it.size - offset));
    const buf = Buffer.alloc(len);
    if (len) { const fd = fs.openSync(fileOf(it.id), "r"); try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); } }
    return [200, { size: it.size, data: buf.toString("base64") }];
  }
  if (p === "/pc/droptaken") {
    if (!forMe) return [403, { error: "Not yours" }];
    drop(it); it.state = "taken"; it.done = Date.now(); save();
    note(`Beam: ${devices.get(me.id)?.name || "A device"} picked up ${it.name}`);
    return [200, { ok: true }];
  }
  return [404, { error: "Unknown Beam request" }];
}

function forget(id) {
  if (!devices.delete(String(id))) return false;
  for (const it of items) if (it.to === id && (it.state === "up" || it.state === "ready")) { drop(it); it.state = "declined"; it.done = Date.now(); }
  saveDevices(); save(); return true;
}

load();
module.exports = { handle, see, list, forget, online };
