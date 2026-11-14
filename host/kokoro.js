// The natural voice: Kokoro (hexgrad/Kokoro-82M, Apache-2.0) via kokoro-onnx (MIT). Sounds like a person reading, where Piper sounds
// like a voice assistant. Speaks English (American and British), Spanish, French, Italian, Portuguese, Hindi, Japanese and Chinese;
// German and anything else stay with Piper. Runs on the processor, about three times faster than it talks.
// One click in Settings → Tools → Add-ons installs it into its own folder (<LocalAppData>\Albatross\kokoro: its own Python packages,
// about 200 MB, and the voice model, 350 MB). Then host/voice.js uses it for every reply read aloud in those languages.
//   /agent/kokoro/status   /agent/kokoro/get   /agent/kokoro/remove   /agent/kokoro/voice {voice}   /agent/kokoro/try {text, voice}
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const DIR = process.env.ALB_KOKORO_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross", "kokoro");
const VPY = path.join(DIR, "venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const REL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/";
const FILES = [{ name: "kokoro-v1.0.onnx", size: 325532387 }, { name: "voices-v1.0.bin", size: 28214398 }];
const CFG = path.join(DIR, "config.json");
const LANGS = ["en", "es", "fr", "it", "pt", "hi", "ja", "zh"];
// the English voices offered in Settings (all 54 work; these are the clearest)
const VOICES = [
  { id: "af_heart", name: "Heart · American, woman" }, { id: "af_bella", name: "Bella · American, woman" },
  { id: "am_michael", name: "Michael · American, man" }, { id: "am_fenrir", name: "Fenrir · American, man" },
  { id: "bf_emma", name: "Emma · British, woman" }, { id: "bm_george", name: "George · British, man" },
];
const filesThere = () => FILES.every((f) => { try { return fs.statSync(path.join(DIR, f.name)).size >= f.size * 0.99; } catch { return false; } });
const installed = () => fs.existsSync(VPY) && filesThere() && fs.existsSync(path.join(DIR, "ready"));
const config = () => { try { return { on: true, voice: "af_heart", ...JSON.parse(fs.readFileSync(CFG, "utf8")) }; } catch { return { on: true, voice: "af_heart" }; } };
const saveConfig = (c) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c)); };
const inst = { running: false, step: "", got: 0, total: 0, error: "" };

function findPython() {
  if (process.env.ALBATROSS_PYTHON) return process.env.ALBATROSS_PYTHON;
  const base = path.join(process.env.LOCALAPPDATA || "", "Python");
  try { for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "python.exe"); if (fs.existsSync(p)) return p; } } catch {}
  return "python";
}
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64e6, timeout: 20 * 60e3 },
  (e, out, err) => e ? fail(new Error((String(err || "").trim().split(/\r?\n/).pop() || e.message).slice(0, 240))) : ok(String(out))));
const download = (f) => new Promise((ok, fail) => {
  const st = { running: true, got: 0, total: f.size, error: "" }, base = inst.got;
  const tick = setInterval(() => { inst.got = base + st.got; }, 500);
  require("./comfy")._test.fetchResumable(REL + f.name, path.join(DIR, f.name), f.size * 0.99, st, (err) => { clearInterval(tick); inst.got = base + f.size; err ? fail(err) : ok(); });
});

async function install(note) {
  if (inst.running || installed()) return;
  Object.assign(inst, { running: true, step: "Starting…", got: 0, total: FILES.reduce((n, f) => n + f.size, 0), error: "" });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { const s = fs.statfsSync(DIR); if (s.bavail * s.bsize < 1.5e9) throw new Error("Not enough free disk space (it needs about 600 MB)"); } catch (e) { if (/disk space/.test(e.message)) throw e; }
    inst.step = "Downloading the voice model…";
    const complete = (f) => { try { return fs.statSync(path.join(DIR, f.name)).size >= f.size * 0.99; } catch { return false; } };
    for (const f of FILES) { if (complete(f)) inst.got += f.size; else await download(f); }
    if (!filesThere()) throw new Error("The download was cut off. Press Download again to continue where it stopped.");
    inst.step = "Making its own Python folder…";
    if (!fs.existsSync(VPY)) await run(findPython(), ["-m", "venv", path.join(DIR, "venv")]);
    inst.step = "Installing the speech engine (a minute or two)…";
    await run(VPY, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "kokoro-onnx"]);
    inst.step = "Trying it out…";
    fs.writeFileSync(path.join(DIR, "ready"), new Date().toISOString());
    const r = await speak("Hello, this is the natural voice.", "en").catch((e) => { throw new Error("It installed, but couldn't speak: " + e.message); });
    if (!r || !r.wav) throw new Error("It installed, but couldn't speak");
    note && note("Voice: installed the natural voice (Kokoro)");
  } catch (e) { inst.error = e.message; try { fs.rmSync(path.join(DIR, "ready"), { force: true }); } catch {} }
  finally { inst.running = false; inst.step = ""; }
}

// ---------- the helper process (stays loaded for a quarter hour after the last reply) ----------
let proc = null, buf = "", idle = null;
const waiting = new Map();
function stop() { if (proc) { try { proc.kill(); } catch {} } proc = null; for (const [, w] of waiting) w.reject(new Error("The natural voice stopped")); waiting.clear(); }
function start() {
  if (proc) return;
  const p = spawn(VPY, ["-u", path.join(__dirname, "kokoro.py"), path.join(DIR, FILES[0].name)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  proc = p; buf = "";
  p.stdout.on("data", (d) => {
    buf += d.toString("utf8"); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      const w = waiting.get(j.id); if (!w) continue;
      waiting.delete(j.id); clearTimeout(w.timer); j.error ? w.reject(new Error(j.error)) : w.resolve(j);
    }
  });
  p.stderr.on("data", () => {});
  p.on("error", () => { if (proc === p) stop(); });
  p.on("exit", () => { if (proc === p) stop(); });
}
function ask(req, ms = 120000) {
  start();
  clearTimeout(idle); idle = setTimeout(stop, 15 * 60e3); idle.unref?.();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("The natural voice took too long")); }, ms);
    waiting.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ ...req, id }) + "\n");
  });
}
const speaks = (lang) => LANGS.includes(String(lang || "en").split("-")[0].toLowerCase());
// {wav} in Kokoro's voice, or null when it isn't installed, is switched off, or doesn't speak that language (Piper takes over)
async function speak(text, lang = "en", voice) {
  if (!installed() || !speaks(lang)) return null;
  const c = config(); if (!c.on && !voice) return null;
  const r = await ask({ op: "tts", text: String(text).slice(0, 4000), lang, voice: voice || c.voice });
  return r.none ? null : r;
}

async function handle(method, p, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  try {
    if (p === "/agent/kokoro/status") { const c = config(); return [200, { installed: installed(), on: c.on, voice: c.voice, voices: VOICES, langs: LANGS, sizeBytes: 560e6, install: { ...inst } }]; }
    if (p === "/agent/kokoro/get") { install(note); return [200, { started: true }]; }
    if (p === "/agent/kokoro/voice") {
      const c = config();
      if (typeof j.voice === "string" && /^[a-z]{2}_[a-z]+$/.test(j.voice)) c.voice = j.voice;
      if (typeof j.on === "boolean") c.on = j.on;
      saveConfig(c); return [200, { voice: c.voice, on: c.on }];
    }
    if (p === "/agent/kokoro/try") {
      const r = await speak(String(j.text || "Hello! This is how I sound when I read my answers to you."), "en", String(j.voice || config().voice));
      if (!r) throw new Error("The natural voice isn't installed");
      return [200, { wav: r.wav }];
    }
    if (p === "/agent/kokoro/remove") {
      if (inst.running) throw new Error("It is installing: wait until it is done");
      stop(); await new Promise((r) => setTimeout(r, 800));
      fs.rmSync(DIR, { recursive: true, force: true });
      return [200, { removed: true }];
    }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown voice request" }];
}
process.on("exit", stop);
module.exports = { handle, speak, installed, speaks, stop };
