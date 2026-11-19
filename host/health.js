// What is slowing Albatross down or stopping it, found out and said in plain words. The desktop app asks every 20 seconds (GET /health)
// and shows a card in front of the user's other apps when something stays wrong (desktop/health.js).
//   /health                       -> { at, issues: [{ id, level: "warn" | "error", title, detail, fix?: { id, label } }] }
//   /agent/health/fix { id }      -> { done: "what was done" }
// Everything here is cheap and local: a few reads of Windows and of nvidia-smi, nothing leaves the PC.
const os = require("os"), fs = require("fs"), { execFile } = require("child_process");

let OLLAMA = "http://127.0.0.1:11434";
const sh = (file, args, ms = 4000) => new Promise((ok) => execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 2e6 }, (err, out) => ok(err ? "" : String(out))));
const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
const NVSMI = [process.env.NVSMI, "nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"].filter(Boolean);
async function nvidia(args) { for (const f of NVSMI) { const out = await sh(f, args); if (out.trim()) return out; } return ""; }

// --- the probes: each returns a list of issues (empty when all is well). They take their inputs, so tests can feed them made-up ones.
function ollamaIssues(ps) {
  if (!ps) return [{ id: "ollama-down", level: "error", title: "Ollama isn't answering", detail: "The AI can't run until Ollama is running again. Start it from the Start menu, or restart your PC." }];
  const out = [];
  for (const m of ps.models || []) {
    const size = Number(m.size) || 0, vram = Number(m.size_vram) || 0;
    if (size > 0 && vram < size * 0.9) {
      const pct = Math.round(vram / size * 100);
      out.push({ id: "cpu-spill", level: "warn", title: `${m.name} is partly running on the processor`, detail: `Only ${pct}% of the model fits on the graphics card, so every answer is much slower. Freeing graphics memory and reloading the model usually fixes it.`, fix: { id: "free-gpu", label: "Free graphics memory" } });
      break;
    }
  }
  return out;
}
// Graphics memory that Albatross itself holds (the chat model Ollama has loaded, the picture engine) is not a problem: a loaded
// model is supposed to fill the card, and "it's full" would then only describe Albatross working. It only counts as full when
// other programs take a real share of it, so a model can't fit next to them.
const OURS = /^(ollama|ollama_llama_server|llama-server|python)$/i;
function gpuIssues(g) {
  if (!g) return [];
  const out = [], pct = g.total ? g.used / g.total : 0;
  const listed = (g.apps || []).filter((a) => OURS.test(a.name)).reduce((s, a) => s + (a.mem || 0), 0);
  const ours = Math.min(g.used, Math.max(listed, (g.ollama || 0) + (g.comfy || 0)));
  const others = g.used - ours;
  if (pct >= 0.93 && others >= g.total * 0.25) {
    const who = (g.apps || []).filter((a) => !OURS.test(a.name) && a.mem > 0).slice(0, 3).map((a) => `${a.name} ${gb(a.mem)}`).join(", ");
    out.push({ id: "gpu-full", level: "warn", title: "Other programs fill the graphics memory", detail: `${gb(g.used)} of ${gb(g.total)} is in use, ${gb(others)} of it by other programs${who ? " (" + who + ")" : ""}${ours > 0.5e9 ? `; Albatross's own model takes ${gb(ours)}, which is normal` : ""}. New models then load slowly or run on the processor. Closing a game or another AI program frees it.` });
  }
  if (g.temp >= 87) out.push({ id: "gpu-hot", level: "warn", title: `The graphics card is hot (${g.temp} °C)`, detail: "It slows itself down to cool off. Check that the PC's fans are running and the vents are clear." });
  else if (g.throttle & 0x60) out.push({ id: "gpu-throttle", level: "warn", title: "The graphics card is holding back", detail: "Windows or the card is limiting its speed (heat or power). Answers will be slower than usual." });
  return out;
}
function ramIssues(m) {
  const used = 1 - m.free / m.total;
  return m.free < 1.2e9 || used > 0.94 ? [{ id: "ram-low", level: "warn", title: "Your PC is almost out of memory", detail: `Only ${gb(m.free)} of ${gb(m.total)} is free${m.top ? ". The biggest users: " + m.top : ""}. Close a few programs to keep Albatross fast.` }] : [];
}
function diskIssues(d) {
  return d && (d.free < 4e9 || d.free / d.total < 0.03) ? [{ id: "disk-low", level: "warn", title: "Your disk is almost full", detail: `${gb(d.free)} left on ${d.drive}. Models and pictures need room; free some space.` }] : [];
}
function powerIssues(scheme) {
  return /a1841308-3541-4fab-bc81-f71556f20b4a/i.test(scheme || "") ? [{ id: "power-saver", level: "warn", title: "Windows is in Power saver mode", detail: "It slows the processor and graphics card down to save energy, so Albatross runs slower. Switch to Balanced or High performance in Windows' power settings." }] : [];
}
function cpuIssues(pct, top) {
  return pct >= 95 ? [{ id: "cpu-busy", level: "warn", title: "Another program is using the whole processor", detail: `The processor has been at ${Math.round(pct)}%${top ? ", mostly " + top : ""}. Albatross has to wait for its turn.` }] : [];
}

// --- gathering
// Who holds how much graphics memory, from Windows itself (the "GPU Process Memory" counters). nvidia-smi can't say this on
// Windows ([N/A] for every program), and Ollama's /api/ps doesn't always list a runner that is still holding a model.
async function gpuByProcess() {
  if (process.platform !== "win32") return [];
  const ps = String.raw`$ErrorActionPreference = 'SilentlyContinue'; (Get-Counter '\GPU Process Memory(*)\Dedicated Usage').CounterSamples | Where-Object { $_.CookedValue -gt 50MB } | ForEach-Object { $id = [int]($_.InstanceName -replace '^pid_(\d+)_.*', '$1'); $p = Get-Process -Id $id; '' + $p.ProcessName + '|' + [int64]$_.CookedValue }`;
  const out = await sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 8000);
  const by = {};
  for (const line of out.split(/\r?\n/)) { const [name, mem] = line.trim().split("|"); if (name && +mem > 0) by[name] = (by[name] || 0) + +mem; }
  return Object.entries(by).map(([name, mem]) => ({ name, mem })).sort((a, b) => b.mem - a.mem);
}
let lastCpu = null, lastResult = null, lastAt = 0, powerCache = { at: 0, v: "" };
function cpuNow() {
  const t = os.cpus().reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
  const prev = lastCpu; lastCpu = t;
  return prev && t.total > prev.total ? (1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100 : 0;
}
async function topProcesses(by) {
  const ps = `Get-Process | Sort-Object ${by === "cpu" ? "CPU" : "WorkingSet64"} -Descending | Select-Object -First 3 | ForEach-Object { $_.ProcessName + ' ' + [int]($_.WorkingSet64/1MB) + ' MB' }`;
  return (await sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 6000)).trim().split(/\r?\n/).filter(Boolean).join(", ");
}
async function gather() {
  const [ps, gpuRaw, appsRaw, comfyStats] = await Promise.all([
    fetch(OLLAMA + "/api/ps", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null),
    // ComfyUI (the picture engine Albatross starts) says how much graphics memory it holds; nothing answers when it isn't running
    nvidia(["--query-gpu=memory.used,memory.total,temperature.gpu,clocks_throttle_reasons.active", "--format=csv,noheader,nounits"]),
    nvidia(["--query-compute-apps=process_name,used_memory", "--format=csv,noheader,nounits"]),
    fetch((process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/+$/, "") + "/system_stats", { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null),
  ]);
  let gpu = null;
  const m = /^\s*(\d+),\s*(\d+),\s*(\d+),\s*(0x[0-9a-f]+|\d+)/i.exec(gpuRaw);
  if (m) gpu = { used: +m[1] * 1048576, total: +m[2] * 1048576, temp: +m[3], throttle: parseInt(m[4], m[4].startsWith("0x") ? 16 : 10) || 0,
    apps: appsRaw.trim().split(/\r?\n/).map((l) => { const [n, mem] = l.split(/,\s*/); return { name: (n || "").split(/[\\/]/).pop().replace(/\.exe$/i, ""), mem: (+mem || 0) * 1048576 }; }).filter((a) => a.name).sort((a, b) => b.mem - a.mem),
    ollama: ((ps && ps.models) || []).reduce((s, x) => s + (Number(x.size_vram) || 0), 0),
    comfy: ((comfyStats && comfyStats.devices) || []).reduce((s, d) => s + (Number(d.torch_vram_total) || 0), 0) };
  // only worth asking when the card is nearly full
  if (gpu && gpu.total && gpu.used / gpu.total >= 0.93) { const real = await gpuByProcess(); if (real.length) gpu.apps = real; }
  const mem = { free: os.freemem(), total: os.totalmem(), top: "" };
  if (mem.free < 1.2e9 || 1 - mem.free / mem.total > 0.94) mem.top = await topProcesses("mem");
  let disk = null;
  try { const drive = process.platform === "win32" ? "C:\\" : "/", f = fs.statfsSync(drive); disk = { free: f.bavail * f.bsize, total: f.blocks * f.bsize, drive: drive.replace(/\\$/, "") }; } catch {}
  if (Date.now() - powerCache.at > 60000) { powerCache = { at: Date.now(), v: process.platform === "win32" ? await sh("powercfg", ["/getactivescheme"]) : "" }; }
  const cpu = cpuNow();
  return { ps, gpu, mem, disk, power: powerCache.v, cpu, cpuTop: cpu >= 95 ? await topProcesses("cpu") : "" };
}
let cpuHigh = 0;   // the processor counts only when it stays busy for a few checks in a row, not for a spike
function issuesFrom(d) {
  cpuHigh = d.cpu >= 95 ? cpuHigh + 1 : 0;
  return [...ollamaIssues(d.ps), ...gpuIssues(d.gpu), ...ramIssues(d.mem), ...diskIssues(d.disk), ...powerIssues(d.power), ...cpuIssues(cpuHigh >= 3 ? d.cpu : 0, d.cpuTop)];
}
async function check() {
  if (lastResult && Date.now() - lastAt < 8000) return lastResult;
  try { lastResult = { at: Date.now(), issues: issuesFrom(await gather()) }; }
  catch (e) { lastResult = { at: Date.now(), issues: [], error: e.message }; }
  lastAt = Date.now();
  return lastResult;
}
// the fixes: only things that are safe and undo themselves (a model that is unloaded just loads again on the next question)
async function fix(id, deps = {}) {
  if (id !== "free-gpu") throw new Error("Unknown fix");
  const done = [];
  if (deps.comfy && (await deps.comfy.release().catch(() => false))) done.push("moved the picture engine's models off the graphics card");
  const ps = await fetch(OLLAMA + "/api/ps", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  for (const m of ollamaIssues(ps)) if (m.id === "cpu-spill") for (const x of ps.models) if (x.size_vram < x.size * 0.9) {
    await fetch(OLLAMA + "/api/generate", { method: "POST", body: JSON.stringify({ model: x.name, keep_alive: 0 }), signal: AbortSignal.timeout(8000) }).catch(() => {});
    done.push(`unloaded ${x.name} so it reloads fully on the graphics card next time`);
  }
  lastAt = 0;
  return { done: done.length ? "Done: " + done.join(" and ") + "." : "Nothing needed freeing." };
}
async function handle(method, p, body, note, deps) {
  if (deps && deps.ollama) OLLAMA = deps.ollama;
  let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
  try {
    if (p === "/health" || p === "/agent/health/status") return [200, await check()];
    if (p === "/agent/health/fix") { const r = await fix(String(j.id || ""), deps); note && note("Health: " + r.done); return [200, r]; }
  } catch (e) { return [400, { error: e.message }]; }
  return [404, { error: "Unknown health request" }];
}
module.exports = { handle, check, fix, ollamaIssues, gpuIssues, ramIssues, diskIssues, powerIssues, cpuIssues };
