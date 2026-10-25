// How long each model took to load into memory the last few times, kept on this PC so every device can show a countdown
// ("usually 12 s, 8 s left") from the same averages, even a phone that has never loaded that model itself.

const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = process.env.ALBATROSS_LOADTIMES || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "loadtimes.json");
const KEEP = 6;   // the last six loads of each model

function all() { try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } }
function record(model, secs) {
  model = String(model || "").slice(0, 120); secs = Math.round(Number(secs));
  if (!model || !(secs >= 1 && secs <= 900)) return false;
  const j = all(); j[model] = [...(Array.isArray(j[model]) ? j[model] : []), secs].slice(-KEEP);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".part"; fs.writeFileSync(tmp, JSON.stringify(j, null, 1)); fs.renameSync(tmp, FILE);
  return true;
}
module.exports = { all, record, FILE };
