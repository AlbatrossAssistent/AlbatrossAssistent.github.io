// The desktop helper for the Hub: runs on the signed-in Windows desktop (the host itself usually runs in Windows' background
// session, where pressed keys and opened programs would never reach the screen). Started by the host through a scheduled task,
// hidden; listens on 127.0.0.1 only, for the host, with a secret token, and knows a fixed list of commands, nothing else:
//   key     a media or volume key         volume   read or set the volume (0..100, mute)    bright  read or set the brightness
//   playing what is playing now (title, artist, cover)      apps / launch  the Start menu's programs, open one
//   url     open a web address in the default browser       lock    lock the PC
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Albatross");
const INFO = path.join(DIR, "desktop.json"), PORT = 4748;
const TOKEN = crypto.randomBytes(24).toString("hex");
const KEYS = { playpause: 0xB3, next: 0xB0, prev: 0xB1, stop: 0xB2, mute: 0xAD, voldown: 0xAE, volup: 0xAF };

// ---------- one PowerShell that stays open; every request is one line, every answer one line "@@<id> <json>" ----------
const SETUP = [
  `$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8`,
  `Add-Type -Name K -Namespace A -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'`,
  // the default speakers' volume through Windows' Core Audio (IAudioEndpointVolume)
  `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float l, Guid c); int j(); int GetMasterVolumeLevelScalar(out float l); int k(); int l(); int m(); int n(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, Guid c); int GetMute(out bool m); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int ctx, int p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public class AlbAudio {
  static IAudioEndpointVolume V() { var e = new MMDeviceEnumeratorCom() as IMMDeviceEnumerator; IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); IAudioEndpointVolume v; var id = typeof(IAudioEndpointVolume).GUID; Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, 0, out v)); return v; }
  public static float Get() { float l; Marshal.ThrowExceptionForHR(V().GetMasterVolumeLevelScalar(out l)); return l; }
  public static void Set(float l) { Marshal.ThrowExceptionForHR(V().SetMasterVolumeLevelScalar(l, Guid.Empty)); }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(V().GetMute(out m)); return m; }
  public static void Mute(bool m) { Marshal.ThrowExceptionForHR(V().SetMute(m, Guid.Empty)); }
}'`,
  // waiting for Windows' async calls (what is playing)
  `Add-Type -AssemblyName System.Runtime.WindowsRuntime; $global:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1`,
  `function Await($op, [Type]$t) { $task = $global:AsTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(5000); $task.Result }`,
  `$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]`,
  `$global:lastCover = @{ key = ""; data = "" }`,
  `function Playing { $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]); $s = $m.GetCurrentSession(); if (-not $s) { return @{ none = $true } }; $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]); $key = $s.SourceAppUserModelId + "|" + $p.Title + "|" + $p.Artist; if ($p.Thumbnail -and $global:lastCover.key -ne $key) { try { $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]); $ms = New-Object IO.MemoryStream; [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($st).CopyTo($ms); $global:lastCover = @{ key = $key; data = [Convert]::ToBase64String($ms.ToArray()) } } catch { $global:lastCover = @{ key = $key; data = "" } } }; @{ title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; app = $s.SourceAppUserModelId; status = [string]$s.GetPlaybackInfo().PlaybackStatus; cover = $(if ($global:lastCover.key -eq $key) { $global:lastCover.data } else { "" }); coverKey = $key } }`,
];
let ps = null, seq = 0, buf = "";
const waiting = new Map();
function shell() {
  if (ps && ps.exitCode === null && !ps.killed) return ps;
  ps = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      const m = /^@@(\d+) (!?)(.*)$/.exec(line); if (!m) continue;
      const w = waiting.get(m[1]); if (!w) continue; waiting.delete(m[1]); clearTimeout(w.t);
      if (m[2]) w.rej(new Error(m[3] || "failed")); else { try { w.res(m[3] ? JSON.parse(m[3]) : null); } catch { w.res(null); } }
    }
  });
  ps.on("exit", () => { for (const w of waiting.values()) w.rej(new Error("PowerShell closed")); waiting.clear(); });
  for (const l of SETUP) ps.stdin.write(l.replace(/\r?\n/g, " ") + "\n");
  return ps;
}
// runs one line of PowerShell, resolves with what it returned (as JSON)
function psRun(code, ms = 15000) {
  const p = shell(), id = String(++seq);
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej, t: setTimeout(() => { waiting.delete(id); rej(new Error("The PC took too long")); }, ms) });
    p.stdin.write(`try { $r = & { ${code} }; [Console]::Out.WriteLine("@@${id} " + $(if ($null -eq $r) { "" } else { ConvertTo-Json -Compress -Depth 4 $r })) } catch { [Console]::Out.WriteLine("@@${id} !" + ($_.Exception.Message -replace "[\\r\\n]+", " ")) }\n`);
  });
}
const press = (vk) => psRun(`[A.K]::keybd_event(${vk},0,1,[UIntPtr]::Zero); [A.K]::keybd_event(${vk},0,3,[UIntPtr]::Zero); $null`);

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
  if (cmd === "key") { if (!KEYS[arg]) throw new Error("Unknown key"); await press(KEYS[arg]); return { ok: true }; }
  if (cmd === "volume") {
    if (arg && typeof arg === "object") {
      if (typeof arg.level === "number") await psRun(`[AlbAudio]::Set(${Math.max(0, Math.min(100, Math.round(arg.level))) / 100}); $null`);
      if (typeof arg.mute === "boolean") await psRun(`[AlbAudio]::Mute($${arg.mute}); $null`);
    }
    return psRun(`@{ level = [math]::Round([AlbAudio]::Get() * 100); mute = [AlbAudio]::Muted() }`);
  }
  if (cmd === "bright") {
    if (arg && typeof arg.level === "number") await psRun(`$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1; [void](Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 0; Brightness = [byte]${Math.max(0, Math.min(100, Math.round(arg.level)))} }); $null`)
      .catch(() => { throw new Error("This screen's brightness can't be changed from Windows (usually only laptop screens can)."); });
    return psRun(`$b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1; @{ level = [int]$b.CurrentBrightness }`)
      .catch(() => { throw new Error("This screen's brightness can't be changed from Windows (usually only laptop screens can)."); });
  }
  if (cmd === "playing") { const r = await psRun(`Playing`, 12000); if (r && arg && arg.coverKey && r.coverKey === arg.coverKey) r.cover = ""; return r || { none: true }; }   // the cover only when it changed
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
  if (cmd === "ping") return { ok: true, pid: process.pid, v: 2 };
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
  fs.writeFileSync(INFO, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid, v: 2 }));
  shell();
});
