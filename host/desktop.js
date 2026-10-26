// The desktop helper for the Hub: runs on the signed-in Windows desktop (the host itself usually runs in Windows' background
// session, where pressed keys and opened programs would never reach the screen). Started by the host through a scheduled task,
// hidden; listens on 127.0.0.1 only, for the host, with a secret token, and knows a fixed list of commands, nothing else:
//   key    a media or volume key            apps    the Start menu's programs      launch  open one of them
//   url    open a web address in the default browser                               lock    lock the PC
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross");
const INFO = path.join(DIR, "desktop.json"), PORT = 4748;
const TOKEN = crypto.randomBytes(24).toString("hex");
const KEYS = { playpause: 0xB3, next: 0xB0, prev: 0xB1, stop: 0xB2, mute: 0xAD, voldown: 0xAE, volup: 0xAF };

// one PowerShell that stays open: a key press is one line to it, so it is quick
let ps = null;
function shell() {
  if (ps && !ps.killed && ps.exitCode === null) return ps;
  ps = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  ps.stdin.write(`Add-Type -Name K -Namespace A -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'\n`);
  return ps;
}
function press(vk) { shell().stdin.write(`[A.K]::keybd_event(${vk},0,1,[UIntPtr]::Zero); [A.K]::keybd_event(${vk},0,3,[UIntPtr]::Zero)\n`); }

let appsCache = { t: 0, list: [] };
function apps() {
  if (Date.now() - appsCache.t < 5 * 60e3 && appsCache.list.length) return Promise.resolve(appsCache.list);
  return new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 20000, maxBuffer: 8e6 }, (e, out) => {
    let list = []; try { const j = JSON.parse(String(out)); list = (Array.isArray(j) ? j : [j]).filter((a) => a && a.Name && a.AppID).map((a) => ({ name: String(a.Name), id: String(a.AppID) })); } catch {}
    list = list.filter((a) => !/^(uninstall|deinstall|readme|help|documentation)/i.test(a.name)).sort((a, b) => a.name.localeCompare(b.name));
    appsCache = { t: Date.now(), list }; res(list);
  }));
}

async function run(cmd, arg) {
  if (cmd === "key") { if (!KEYS[arg]) throw new Error("Unknown key"); press(KEYS[arg]); return { ok: true }; }
  if (cmd === "apps") return { apps: await apps() };
  if (cmd === "launch") {
    const a = (await apps()).find((x) => x.id === arg); if (!a) throw new Error("That program isn't in the Start menu.");
    const c = spawn("explorer.exe", ["shell:AppsFolder\\" + a.id], { detached: true, stdio: "ignore", windowsHide: true }); c.on("error", () => {}); c.unref();
    return { ok: true, name: a.name };
  }
  if (cmd === "url") {
    const u = String(arg || ""); if (!/^https?:\/\/[^\s"'<>]+$/i.test(u) || u.length > 2000) throw new Error("Only web addresses (http/https) can be opened.");
    execFile("rundll32.exe", ["url.dll,FileProtocolHandler", u], { windowsHide: true }, () => {}); return { ok: true };
  }
  if (cmd === "lock") { execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true }, () => {}); return { ok: true }; }
  if (cmd === "ping") return { ok: true, pid: process.pid };
  throw new Error("Unknown command");
}

const server = http.createServer((req, res) => {
  const send = (s, j) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.method !== "POST" || req.url !== "/do" || req.headers["x-token"] !== TOKEN || req.headers.origin) return send(403, { error: "no" });
  let body = ""; req.on("data", (d) => { body += d; if (body.length > 1e5) req.destroy(); });
  req.on("end", async () => { let j = {}; try { j = JSON.parse(body); } catch {} try { send(200, await run(String(j.cmd || ""), j.arg)); } catch (e) { send(400, { error: e.message }); } });
});
server.on("error", () => process.exit(0));                     // another helper already runs
server.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INFO, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid, session: process.env.SESSIONNAME || "" }));
  shell();
});
