// The host's side of the desktop helper (desktop.js): starts it on the signed-in desktop when needed (a scheduled task that runs
// it hidden, made once) and passes the Hub's commands to it.
const fs = require("fs"), path = require("path"), os = require("os");
const { execFile } = require("child_process");

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross");
const INFO = path.join(DIR, "desktop.json"), TASK = "Albatross desktop";
const info = () => { try { return JSON.parse(fs.readFileSync(INFO, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (e, out, err) => res({ ok: !e, out: String(out || "") + String(err || "") })));

async function ask(cmd, arg) {
  const i = info(); if (!i) throw new Error("not running");
  const r = await fetch(`http://127.0.0.1:${i.port}/do`, { method: "POST", headers: { "Content-Type": "application/json", "x-token": i.token }, body: JSON.stringify({ cmd, arg }), signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "HTTP " + r.status); e.answered = true; throw e; }
  return j;
}
let starting = null;
function start() {
  if (starting) return starting;
  starting = (async () => {
    if (process.platform !== "win32") throw new Error("The Hub's PC controls are only set up for Windows.");
    // run hidden (no console window) through a little VBScript; the task runs it on the signed-in desktop (/IT)
    const vbs = path.join(DIR, "desktop.vbs");
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${path.join(__dirname, "desktop.js")}""", 0, False\r\n`);
    let r = await sh("schtasks", ["/Run", "/TN", TASK]);
    if (!r.ok) {
      await sh("schtasks", ["/Create", "/TN", TASK, "/TR", `wscript.exe "${vbs}"`, "/SC", "ONCE", "/ST", "23:59", "/IT", "/F"]);
      r = await sh("schtasks", ["/Run", "/TN", TASK]);
      if (!r.ok) throw new Error("Couldn't start the desktop helper: " + r.out.trim().slice(0, 160));
    }
    for (let k = 0; k < 40; k++) { await sleep(250); try { await ask("ping"); return; } catch {} }
    throw new Error("The desktop helper didn't start (is someone signed in on the PC?)");
  })().finally(() => { starting = null; });
  return starting;
}
// a helper from an older version (after an update) is closed and started again once, so new commands are there
const HELPER_V = 3;
let checked = false;
async function fresh() {
  if (checked) return; checked = true;
  try { const p = await ask("ping"); if (p.v === HELPER_V) return; const i = info(); if (i && i.pid) try { process.kill(i.pid); } catch {} await sleep(500); } catch {}
  try { fs.unlinkSync(INFO); } catch {}
}
async function call(cmd, arg) {
  await fresh();
  try { return await ask(cmd, arg); }
  catch (e) { if (e.answered) throw e; await start(); return ask(cmd, arg); }
}
module.exports = { call };
