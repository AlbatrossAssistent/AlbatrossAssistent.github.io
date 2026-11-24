// Quiet mode for the Windows app while Albatross is being worked on: tests, builds and host restarts make the PC busy and stop the
// host for a moment, which would otherwise bring up the slowdown warning, notifications or the app window. The app reads the time
// in %LOCALAPPDATA%\Albatross\host\.quiet-until and stays out of sight until then (desktop/main.js quiet()).
//   node tools/quiet.js [minutes]     (default 20; 0 ends it)     · also called by tools/bump.js and test/smoke.js
const fs = require("fs"), path = require("path"), os = require("os");
function quiet(minutes = 20) {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "host");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, ".quiet-until");
    let until = Date.now() + minutes * 60e3;
    if (minutes > 0) { try { until = Math.max(until, Number(fs.readFileSync(file, "utf8")) || 0); } catch {} }   // never shortens a longer quiet time
    fs.writeFileSync(file, String(until));
  } catch {}
}
module.exports = quiet;
if (require.main === module) { const m = Number(process.argv[2] ?? 20); quiet(m); console.log(m > 0 ? `Albatross app quiet for ${m} min` : "Albatross app quiet mode ended"); }
