// Started by Windows at boot (set up with autostart-on.bat), before anyone signs in.
// Makes sure Ollama is running, then starts the Burrow host without a window.
// Output goes to host/background.log. The control center is at http://127.0.0.1:4747.

const fs = require("fs");
const path = require("path");
const util = require("util");
const { spawn } = require("child_process");

const LOG = path.join(__dirname, "background.log");
try { if (fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + ".old"); } catch {}
const out = fs.createWriteStream(LOG, { flags: "a" });
const stamp = () => new Date().toLocaleString();
console.log = (...a) => out.write(`[${stamp()}] ${util.format(...a)}\n`);
process.on("uncaughtException", (e) => { console.log("Crashed:", e.stack || e); process.exit(1); });

const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const up = () => fetch(OLLAMA + "/api/version", { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("Burrow background start");
  if (!(await up())) {
    const exe = [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe")].find((f) => fs.existsSync(f)) || "ollama";
    console.log("Starting Ollama:", exe);
    const ollamaLog = fs.openSync(path.join(__dirname, "ollama-background.log"), "a");
    // One model in memory at a time, also for the website used directly on this PC.
    const env = { ...process.env, OLLAMA_MAX_LOADED_MODELS: "1" };
    const child = spawn(exe, ["serve"], { detached: true, env, stdio: ["ignore", ollamaLog, ollamaLog], windowsHide: true });
    child.on("error", (e) => console.log("Couldn't start Ollama:", e.message));
    child.unref();
    for (let i = 0; i < 60 && !(await up()); i++) await wait(1000);
    console.log((await up()) ? "Ollama is running" : "Ollama didn't start, the host will keep checking");
  } else console.log("Ollama was already running");

  process.argv.push("--no-panel", "--background");
  require("./host.js");
})();
