// Jarvis (the desktop orb in D:\Jarvis) from the website.
// Jarvis listens on 127.0.0.1:4849 for its token only (see jarvis/remote.py there). The host passes the
// website's requests along: end-to-end encrypted from a device with the code, or through the local
// doorway on this PC. It can also start Jarvis when it isn't running.

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const TASK = "Albatross Jarvis";   // created by D:\Burrow\app\jarvis-setup.bat: runs Jarvis on the signed-in desktop

const PORT = 4849;
const APPDATA = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
const TOKEN_FILE = path.join(APPDATA, "Jarvis", "remote-token");
const EXE = process.env.JARVIS_EXE || ["D:\\Jarvis\\dist\\Jarvis\\Jarvis.exe"].find((f) => fs.existsSync(f)) || "";

const token = () => { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; } };
const ALLOWED = new Set(["GET /state", "POST /ask", "POST /stop", "POST /settings", "POST /confirm", "GET /screen"]);

async function call(method, p, body, query = "") {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}${query}`, {
    method, headers: { "X-Jarvis-Token": token(), "Content-Type": "application/json" },
    body: method === "POST" ? body || "{}" : undefined, signal: AbortSignal.timeout(25000),
  });
  return [r.status, await r.json()];
}

let starting = 0;
async function start(note) {
  if (!EXE) return [404, { error: "Jarvis isn't installed on this PC (D:\\Jarvis\\dist\\Jarvis\\Jarvis.exe)." }];
  if (Date.now() - starting < 20000) return [200, { starting: true }];
  starting = Date.now();
  // The host often runs in Windows' background session (started at boot), where a program started directly
  // would be invisible and see a black screen. The "Albatross Jarvis" task always runs on the signed-in
  // desktop; without it (e.g. host started by hand, already on the desktop) start the exe directly.
  const viaTask = await new Promise((res) => execFile("schtasks", ["/Run", "/TN", TASK], { windowsHide: true }, (err) => res(!err)));
  if (!viaTask) {
    const child = spawn(EXE, [], { cwd: path.dirname(EXE), detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
  }
  note("Started Jarvis for the website");
  return [200, { starting: true }];
}

// p looks like "/jarvis/state". Returns [status, json].
async function handle(method, p, body, note, beforeAsk) {
  const sub = p.replace(/^\/jarvis/, "") || "/";
  if (method === "POST" && sub === "/start") return start(note);
  const [route, query] = sub.split("?");
  if (!ALLOWED.has(`${method} ${route}`)) return [404, { error: "Unknown Jarvis request" }];
  if (route === "/ask" && beforeAsk) await beforeAsk();   // free the graphics card for Jarvis's model
  try {
    return await call(method, route, body, query ? "?" + query : "");
  } catch {
    return [503, { error: "Jarvis isn't running on the PC.", offline: true, canStart: !!EXE }];
  }
}

module.exports = { handle };
