// Voice for the website: speech to text (Whisper) and text to speech (Piper), both run on this PC by host/voice.py.
// The Python helper starts with the first request and stops after a quiet quarter hour (it holds the Whisper model in memory).
// /agent/voice/stt {audio: base64, lang}  -> {text, lang}      /agent/voice/tts {text, lang} -> {wav: base64} or {none: true}
// /agent/voice/status -> {ready, stt, device, voices}
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

// the python that has faster-whisper and piper (the plain "python" can be the Microsoft Store stub, which doesn't work in a background task)
function findPython() {
  if (process.env.ALBATROSS_PYTHON) return process.env.ALBATROSS_PYTHON;
  const fs = require("fs"), base = path.join(process.env.LOCALAPPDATA || "", "Python");
  try { for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "python.exe"); if (fs.existsSync(p)) return p; } } catch {}
  return "python";
}
const PY = findPython();
let proc = null, buf = "", idle = null;
const waiting = new Map();

function stop() { if (proc) { try { proc.kill(); } catch {} } proc = null; for (const [, w] of waiting) w.reject(new Error("The voice helper stopped")); waiting.clear(); }
function start() {
  if (proc) return;
  const p = spawn(PY, ["-u", path.join(__dirname, "voice.py")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
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
function ask(req, ms) {
  start();
  clearTimeout(idle); idle = setTimeout(stop, 15 * 60 * 1000); idle.unref?.();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("The voice helper took too long (the first time it downloads its models, which can take a few minutes)")); }, ms);
    waiting.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ ...req, id }) + "\n");
  });
}

async function handle(method, p, body, note) {
  let j = {}; try { j = JSON.parse(body || "{}"); } catch { return [400, { error: "Bad request" }]; }
  try {
    if (p === "/agent/voice/status") return [200, { ...(await ask({ op: "status" }, 60000)), ready: true }];
    if (p === "/agent/voice/stt") {
      if (typeof j.audio !== "string" || j.audio.length > 40 * 1024 * 1024) throw new Error("No audio");
      return [200, await ask({ op: "stt", audio: j.audio, lang: String(j.lang || "").slice(0, 8) }, 15 * 60 * 1000)];
    }
    if (p === "/agent/voice/tts") {
      const text = String(j.text || "").trim(); if (!text) throw new Error("Nothing to say");
      return [200, await ask({ op: "tts", text: text.slice(0, 4000), lang: String(j.lang || "en").slice(0, 8) }, 10 * 60 * 1000)];
    }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown voice request" }];
}
process.on("exit", stop);
module.exports = { handle, stop };
