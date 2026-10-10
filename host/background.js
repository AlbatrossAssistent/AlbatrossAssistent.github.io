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

// Ollama runs from a copy of its program folder. Started from here it has admin rights, and then
// Ollama's own updater (which has none) can't replace the files in use: updates failed half-way and
// left Ollama without its engine. With a copy the updater never meets a locked file. The copy is
// refreshed at the next start after an update, and only from a complete install.
const RUNTIME = path.join(path.dirname(path.dirname(__dirname)), "ollama-runtime");
function runtimeCopy() {
  const src = path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama");
  const done = path.join(RUNTIME, "copied-from.txt"), exe = path.join(RUNTIME, "ollama.exe");
  try {
    const complete = fs.existsSync(path.join(src, "ollama.exe")) && fs.existsSync(path.join(src, "lib", "ollama", "llama-server.exe"));
    if (complete) {
      const st = fs.statSync(path.join(src, "ollama.exe")), stamp = `${st.size} ${st.mtimeMs}`;
      const have = fs.existsSync(done) ? fs.readFileSync(done, "utf8") : "";
      if (have !== stamp) {
        console.log("Copying Ollama to", RUNTIME, "(new version)");
        fs.rmSync(RUNTIME, { recursive: true, force: true });
        fs.cpSync(src, RUNTIME, { recursive: true, filter: (f) => !/unins000/i.test(path.basename(f)) });
        fs.writeFileSync(done, stamp);
      }
    } else console.log("Ollama's own install is incomplete (an update failed?), using the last good copy");
    return fs.existsSync(done) && fs.existsSync(exe) ? exe : null;
  } catch (e) {
    console.log("Couldn't copy Ollama:", e.message);
    return fs.existsSync(done) && fs.existsSync(exe) ? exe : null;
  }
}

(async () => {
  console.log("Burrow background start");
  if (!(await up())) {
    const exe = runtimeCopy() || [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe")].find((f) => fs.existsSync(f)) || "ollama";
    console.log("Starting Ollama:", exe);
    const ollamaLog = fs.openSync(path.join(__dirname, "ollama-background.log"), "a");
    // One model in memory at a time, also for the website used directly on this PC.
    // The website talks to Ollama directly when used on this PC, so Ollama must accept its origin.
    const origins = new Set((process.env.OLLAMA_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean));
    for (const o of ["https://albatrossassistent.github.io", "https://burrowgeneral.github.io", "https://burrow-uu7e.onrender.com"]) origins.add(o);
    const env = { ...process.env, OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_ORIGINS: [...origins].join(",") };
    const child = spawn(exe, ["serve"], { detached: true, env, stdio: ["ignore", ollamaLog, ollamaLog], windowsHide: true });
    child.on("error", (e) => console.log("Couldn't start Ollama:", e.message));
    child.unref();
    for (let i = 0; i < 60 && !(await up()); i++) await wait(1000);
    console.log((await up()) ? "Ollama is running" : "Ollama didn't start, the host will keep checking");
  } else console.log("Ollama was already running");

  process.argv.push("--no-panel", "--background");
  require("./host.js");
})();
