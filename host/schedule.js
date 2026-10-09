// The PC's own power schedule, run by the host (which runs from boot, even before anyone signs in):
//   - sleep or shut down after some hours without use (no Albatross requests AND nobody at the keyboard)
//   - sleep or shut down every day at a set time
//   - wake up every day at a set time (from sleep; Windows wake timers can't start a PC that is fully off)
// Settings live in host/schedule.json. Windows' own task scheduler does two things the host can't:
// "Albatross wake" (a wake timer) and "Albatross idle check" (it only runs while nobody uses the PC).

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const FILE = path.join(__dirname, "schedule.json");
const PANEL = Number(process.env.BURROW_PANEL_PORT) || 4747;
const DEFAULTS = {
  idle: { on: false, hours: 2, action: "sleep" },
  daily: { on: false, time: "01:00", action: "sleep" },
  wake: { on: false, time: "07:00" },
};
const ps = (script) => new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000 }, (err, out, errOut) => res({ ok: !err, out: String(out || ""), err: String(errOut || err?.message || "") })));

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); return { idle: { ...DEFAULTS.idle, ...j.idle }, daily: { ...DEFAULTS.daily, ...j.daily }, wake: { ...DEFAULTS.wake, ...j.wake } }; }
  catch { return structuredClone(DEFAULTS); }
}
let cfg = load();
let lastActivity = Date.now();     // last chat, picture, file or Jarvis request
let lastIdleTick = 0;              // last time Windows said "nobody is using this PC"
let lastDaily = "";                // the date the daily action last ran
let note = () => {};

const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

// ---------- doing it ----------
function sleepNow() {
  // Suspend (not hibernate). Allowed even while the host itself blocks automatic sleep.
  return ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null");
}
function shutdownSoon(seconds, why) {
  return new Promise((res) => execFile("shutdown", ["/s", "/t", String(seconds), "/c", `Albatross: ${why}. To stop it, cancel on the website or run: shutdown /a`], { windowsHide: true }, (err) => res(!err)));
}
async function act(action, why) {
  note(`${action === "shutdown" ? "Shutting down" : "Going to sleep"}: ${why}`);
  if (action === "shutdown") return shutdownSoon(120, why);
  return sleepNow();
}

// ---------- Windows tasks ----------
async function syncTasks() {
  if (process.platform !== "win32") return;
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const principal = `$p = New-ScheduledTaskPrincipal -UserId '${user}' -LogonType Interactive -RunLevel Limited;`;
  if (cfg.wake.on && validTime(cfg.wake.time)) {
    await ps(`${principal}
      $a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit';
      $t = New-ScheduledTaskTrigger -Daily -At '${cfg.wake.time}';
      $s = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable;
      Register-ScheduledTask -TaskName 'Albatross wake' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`);
  } else await ps("Unregister-ScheduledTask -TaskName 'Albatross wake' -Confirm:$false -ErrorAction SilentlyContinue");
  if (cfg.idle.on) {
    // every 10 minutes, but only while Windows sees nobody using the PC: then it tells the host
    const url = `http://127.0.0.1:${PANEL}/action/idle-tick`;
    await ps(`${principal}
      $a = New-ScheduledTaskAction -Execute 'curl.exe' -Argument '-s -m 5 -X POST -H "X-Burrow: 1" ${url}';
      $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10);
      $s = New-ScheduledTaskSettingsSet -RunOnlyIfIdle -IdleDuration (New-TimeSpan -Minutes 10) -IdleWaitTimeout (New-TimeSpan -Minutes 9) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden;
      $s.IdleSettings.StopOnIdleEnd = $false;
      Register-ScheduledTask -TaskName 'Albatross idle check' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`);
  } else await ps("Unregister-ScheduledTask -TaskName 'Albatross idle check' -Confirm:$false -ErrorAction SilentlyContinue");
}

// nobody signed in at all (e.g. started by Wake-on-LAN): then nobody is at the keyboard either
function nobodySignedIn() {
  return new Promise((res) => execFile("query", ["user"], { windowsHide: true }, (err, out) => res(!!err || !/Active|Aktiv/i.test(String(out || "")))));
}

// ---------- the clock ----------
async function tick() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hhmm = now.toTimeString().slice(0, 5);
  if (cfg.daily.on && validTime(cfg.daily.time) && hhmm === cfg.daily.time && lastDaily !== today) {
    lastDaily = today;
    await act(cfg.daily.action, `scheduled for ${cfg.daily.time} every day`);
    return;
  }
  if (cfg.idle.on) {
    const unused = Date.now() - lastActivity >= cfg.idle.hours * 3600e3;
    const keyboardIdle = Date.now() - lastIdleTick < 25 * 60e3 || (await nobodySignedIn());
    if (unused && keyboardIdle) {
      lastActivity = Date.now();               // don't repeat right after waking up again
      await act(cfg.idle.action, `nobody used the PC for ${cfg.idle.hours} hour${cfg.idle.hours === 1 ? "" : "s"}`);
    }
  }
}

function start(noteFn) {
  note = noteFn || note;
  setInterval(() => tick().catch(() => {}), 30000).unref();
  syncTasks().catch(() => {});
}
function activity() { lastActivity = Date.now(); }
function idleTick() { lastIdleTick = Date.now(); return { ok: true }; }
function get() { return { ...cfg, lastActivity, idleNow: Date.now() - lastIdleTick < 25 * 60e3 }; }
async function set(body) {
  const n = structuredClone(cfg);
  if (body.idle) {
    n.idle.on = !!body.idle.on;
    n.idle.hours = Math.min(24, Math.max(.25, Number(body.idle.hours) || n.idle.hours));
    n.idle.action = body.idle.action === "shutdown" ? "shutdown" : "sleep";
  }
  if (body.daily) {
    n.daily.on = !!body.daily.on;
    if (validTime(body.daily.time)) n.daily.time = body.daily.time;
    n.daily.action = body.daily.action === "shutdown" ? "shutdown" : "sleep";
  }
  if (body.wake) {
    n.wake.on = !!body.wake.on;
    if (validTime(body.wake.time)) n.wake.time = body.wake.time;
  }
  cfg = n;
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  await syncTasks();
  note("Power schedule changed from the website");
  return get();
}

module.exports = { start, activity, idleTick, get, set, sleepNow };
