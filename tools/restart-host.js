// Restarts the Albatross host on this PC (the "Burrow host" task) quietly: the Windows app is told to stay out of sight first, so the
// moment the host is down doesn't bring up the slowdown warning.   node tools/restart-host.js
const { execFileSync } = require("child_process");
require("./quiet")(5);
try { execFileSync("schtasks", ["/End", "/TN", "Burrow host"], { stdio: "ignore" }); } catch {}
execFileSync("schtasks", ["/Run", "/TN", "Burrow host"], { stdio: "inherit" });
