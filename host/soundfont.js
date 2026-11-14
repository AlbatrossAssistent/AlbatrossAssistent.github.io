// SoundFont banks for the Music tool: the instrument sounds the piece is played with. Never downloaded by themselves: the user asks
// (Settings → Tools → Music), then the bank goes to <LocalAppData>\Albatross\soundfonts and is served to the app from this PC at
// /soundfont/<id> (so it plays offline afterwards and nothing links to the authors' download pages).
//   /agent/soundfont/status           -> { banks: [{ id, name, license, about, size, installed, running, got, total, error }] }
//   /agent/soundfont/get {id}         -> starts the download (progress in status)
//   /agent/soundfont/remove {id}      -> deletes that bank from this PC
const fs = require("fs"), path = require("path"), os = require("os"), https = require("https");

const DIR = process.env.ALB_SF_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "soundfonts");
const BANKS = {
  musescore: { name: "MuseScore General", file: "MuseScore_General.sf3", size: 39900972, license: "MIT",
    url: "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
    about: "Cleaner orchestral sounds and a full drum kit. 40 MB." },
  generaluser: { name: "GeneralUser GS", file: "GeneralUser-GS.sf2", size: 32319396, license: "GeneralUser GS License v2 (free to use, also in software)",
    url: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2",
    about: "Warm, punchy General MIDI bank with good drums and guitars. 32 MB." },
};
const state = {};   // id -> { running, got, total, error }
const full = (id) => path.join(DIR, BANKS[id].file);
const installed = (id) => { try { return fs.statSync(full(id)).size > BANKS[id].size * 0.9; } catch { return false; } };

function status() {
  return { banks: Object.entries(BANKS).map(([id, b]) => ({ id, name: b.name, license: b.license, about: b.about, size: b.size, installed: installed(id), ...(state[id] || {}) })) };
}
function download(id, note) {
  const b = BANKS[id], s = (state[id] = { running: true, got: 0, total: b.size, error: "" });
  fs.mkdirSync(DIR, { recursive: true });
  const part = full(id) + ".part";
  const fail = (m) => { s.running = false; s.error = m; try { fs.unlinkSync(part); } catch {} };
  const get = (u, hops = 0) => https.get(u, { headers: { "User-Agent": "Albatross-Desktop" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) { res.resume(); return get(new URL(res.headers.location, u).href, hops + 1); }
    if (res.statusCode !== 200) { res.resume(); return fail("The download failed (" + res.statusCode + ")"); }
    s.total = Number(res.headers["content-length"]) || b.size;
    const out = fs.createWriteStream(part);
    res.on("data", (c) => { s.got += c.length; });
    res.pipe(out);
    out.on("finish", () => out.close(() => {
      if (s.got < b.size * 0.9) return fail("The download was cut off. Try again.");
      try { fs.renameSync(part, full(id)); } catch (e) { return fail(e.message); }
      s.running = false; note && note("Music: downloaded the " + b.name + " sounds");
    }));
    out.on("error", (e) => fail(e.message));
    res.on("error", (e) => fail(e.message));
  }).on("error", (e) => fail(e.message));
  get(b.url);
}
// GET /soundfont/<id>: the file, streamed (the page asking is on this PC, 127.0.0.1)
function serve(req, res, id) {
  if (!BANKS[id] || !installed(id)) { res.writeHead(404); res.end(); return true; }
  const f = full(id), size = fs.statSync(f).size;
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size, "Cache-Control": "max-age=86400" });
  fs.createReadStream(f).pipe(res);
  return true;
}
async function handle(method, p, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  try {
    if (p === "/agent/soundfont/status") return [200, status()];
    if (p === "/agent/soundfont/get") {
      const id = String(j.id || ""); if (!BANKS[id]) throw new Error("Unknown sound bank");
      if (!installed(id) && !(state[id] && state[id].running)) download(id, note);
      return [200, status()];
    }
    if (p === "/agent/soundfont/remove") {
      const id = String(j.id || ""); if (!BANKS[id]) throw new Error("Unknown sound bank");
      if (state[id] && state[id].running) throw new Error("It is still downloading");
      try { fs.unlinkSync(full(id)); } catch {}
      delete state[id]; return [200, status()];
    }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown sound bank request" }];
}
module.exports = { handle, serve, status, BANKS, _test: { DIR, installed } };
