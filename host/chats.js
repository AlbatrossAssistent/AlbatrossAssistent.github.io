// Chats live on this PC, not on each device: every device that knows the code (or the website on this PC) reads and writes the
// same list, so a chat started on the phone continues on the laptop. Nothing leaves this PC unencrypted: devices reach this over
// the end-to-end encrypted relay, the website on this PC through the control center's doorway (only this PC can open it).
//
// One file per chat in <LOCALAPPDATA>\Albatross\Chats\<id>.json (written to a temp file first, so a power cut never leaves half a chat),
// plus deleted.json so a chat deleted on one device is also removed on the others instead of coming back.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.env.ALBATROSS_CHATS || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "Chats");
const MAX_CHAT = 60 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOMBS = path.join(ROOT, "deleted.json");

const cache = new Map();   // file -> { mtime, summary }: listing doesn't have to read every chat again
const file = (id) => path.join(ROOT, id + ".json");
function atomic(target, text) { const tmp = target + ".part"; fs.writeFileSync(tmp, text); fs.renameSync(tmp, target); }
function tombs() { try { return JSON.parse(fs.readFileSync(TOMBS, "utf8")); } catch { return {}; } }
function summary(c) {
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  return { id: c.id, title: String(c.title || "").slice(0, 120), updated: Number(c.updated) || 0, created: Number(c.created) || 0, pinned: !!c.pinned, type: c.type || "chat", n: msgs.length };
}

function handle(method, p, body, note) {
  let j = {};
  try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  fs.mkdirSync(ROOT, { recursive: true });

  if (p === "/chats/list") {
    const list = [];
    for (const f of fs.readdirSync(ROOT)) {
      if (!f.endsWith(".json") || f === "deleted.json") continue;
      try {
        const fp = path.join(ROOT, f), mt = fs.statSync(fp).mtimeMs, hit = cache.get(f);
        if (hit && hit.mt === mt) { list.push(hit.s); continue; }
        const s = summary(JSON.parse(fs.readFileSync(fp, "utf8")));
        cache.set(f, { mt, s }); list.push(s);
      } catch {}
    }
    return [200, { folder: ROOT, chats: list, deleted: tombs() }];
  }
  if (p === "/chats/get") {
    if (!ID.test(String(j.id))) return [400, { error: "Bad chat id" }];
    try { return [200, { chat: JSON.parse(fs.readFileSync(file(j.id), "utf8")) }]; } catch { return [404, { error: "No such chat on this PC" }]; }
  }
  if (p === "/chats/put") {
    const c = j.chat;
    if (!c || !ID.test(String(c.id)) || !Array.isArray(c.messages)) return [400, { error: "Not a chat" }];
    const text = JSON.stringify(c);
    if (text.length > MAX_CHAT) return [413, { error: "That chat is too big to keep" }];
    let old = null; try { old = JSON.parse(fs.readFileSync(file(c.id), "utf8")); } catch {}
    // never replace a newer version with an older one (two devices saving at once): the newer one wins
    if (old && !j.force && Number(old.updated) > Number(c.updated) + 1) return [200, { kept: "pc", updated: Number(old.updated) }];
    atomic(file(c.id), text);
    const t = tombs(); if (t[c.id]) { delete t[c.id]; atomic(TOMBS, JSON.stringify(t)); }
    if (!old) note(`Chats: saved a new chat from a device`);
    return [200, { ok: true, updated: Number(c.updated) || 0 }];
  }
  if (p === "/chats/delete") {
    const ids = (Array.isArray(j.ids) ? j.ids : [j.id]).filter((x) => ID.test(String(x)));
    const t = tombs();
    for (const id of ids) { try { fs.unlinkSync(file(id)); } catch {} t[id] = Date.now(); }
    // forget old tombstones after 90 days
    for (const id in t) if (Date.now() - t[id] > 90 * 864e5) delete t[id];
    atomic(TOMBS, JSON.stringify(t));
    return [200, { ok: true, deleted: ids.length }];
  }
  return [404, { error: "Unknown chats request" }];
}

module.exports = { handle, ROOT };
