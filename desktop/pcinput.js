// Mouse and keyboard for "Let the AI control my PC" (the side panel). One PowerShell stays open for as long as the panel runs a task;
// each request is one line of JSON, each answer one line "@@<id> <json>". It runs in the signed-in session (this app's), so the
// clicks and keys reach the real desktop. It knows a fixed list of moves, nothing else:
//   click  { x, y, button: left|right|middle, count: 1|2 }   physical screen pixels (the same ones the screen look reports)
//   scroll { x, y, amount }                                     amount: notches, + up / - down
//   type   { text }                                             the text as Unicode key presses (any language, no clipboard)
//   keys   { combo }                                            "ctrl+s", "alt+tab", "enter", "win", "ctrl+shift+esc" ...
//   focus  { hwnd }                                             brings that window to the front before typing into it
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const CS = `
using System; using System.Runtime.InteropServices; using System.Threading;
public class AlbInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public U u; }
  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y); Thread.Sleep(60);
    uint down = 2, up = 4; if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; }
    for (int c = 0; c < Math.Max(1, Math.Min(3, count)); c++) { Send(new INPUT[] { M(down, 0), M(up, 0) }); Thread.Sleep(70); }
  }
  public static void Scroll(int x, int y, int notches) { SetCursorPos(x, y); Thread.Sleep(40); Send(new INPUT[] { M(0x0800, (uint)(notches * 120)) }); }
  public static void Type(string s) {
    foreach (char ch in s) {
      if (ch == '\\n') { Send(new INPUT[] { K(0x0D, 0, 0), K(0x0D, 0, 2) }); }
      else if (ch == '\\t') { Send(new INPUT[] { K(0x09, 0, 0), K(0x09, 0, 2) }); }
      else if (ch != '\\r') { Send(new INPUT[] { K(0, ch, 4), K(0, ch, 4 | 2) }); }
      Thread.Sleep(8);
    }
  }
  static bool Ext(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C; }
  public static void Keys(ushort[] vks) {
    foreach (var vk in vks) { Send(new INPUT[] { K(vk, 0, Ext(vk) ? 1u : 0u) }); Thread.Sleep(25); }
    for (int i = vks.Length - 1; i >= 0; i--) { Send(new INPUT[] { K(vks[i], 0, (Ext(vks[i]) ? 1u : 0u) | 2u) }); Thread.Sleep(25); }
  }
  // Windows only lets the program the user last used bring a window forward; a tap of Alt first makes it allow this one
  public static bool Focus(long h) {
    var w = new IntPtr(h); if (IsIconic(w)) ShowWindow(w, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(w);
  }
}`;
const LOOP = `
$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CS}
'@
[void][AlbInput]::SetProcessDPIAware()
[Console]::Out.WriteLine("@@ready")
while ($true) {
  $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }
  try {
    $j = ConvertFrom-Json $line; $a = $j.arg
    switch ($j.cmd) {
      "click" { [AlbInput]::Click([int]$a.x, [int]$a.y, [string]$a.button, [int]$a.count) }
      "scroll" { [AlbInput]::Scroll([int]$a.x, [int]$a.y, [int]$a.amount) }
      "type" { [AlbInput]::Type([string]$a.text) }
      "keys" { [AlbInput]::Keys([uint16[]]@($a.vks)) }
      "focus" { [void][AlbInput]::Focus([long]$a.hwnd) }
    }
    [Console]::Out.WriteLine("@@" + $j.id + ' {"ok":true}')
  } catch { [Console]::Out.WriteLine("@@" + $j.id + " " + (ConvertTo-Json -Compress @{ error = $_.Exception.Message })) }
}
`;

const VK = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, windows: 0x5B, cmd: 0x5B, meta: 0x5B, enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
  space: 0x20, backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2C, menu: 0x5D, plus: 0xBB, minus: 0xBD, comma: 0xBC, period: 0xBE };
for (let i = 1; i <= 12; i++) VK["f" + i] = 0x6F + i;
// "ctrl+shift+s" -> virtual key codes, or an error that says which part isn't a key
function parseCombo(combo) {
  const parts = String(combo || "").toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error("A key combination is one to four keys, like ctrl+s.");
  return parts.map((p) => {
    if (VK[p]) return VK[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    throw new Error(`"${p}" isn't a key I know.`);
  });
}

function create({ log = () => {} } = {}) {
  let ps = null, ready = null, buf = "", seq = 0;
  const waiting = new Map();
  function start() {
    if (ps && ps.exitCode === null) return ready;
    // the loop goes into a script file, so that stdin carries nothing but the requests
    const file = path.join(os.tmpdir(), "albatross-input-" + process.pid + ".ps1");
    fs.writeFileSync(file, "﻿" + LOOP);
    ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
    ready = new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error("The mouse and keyboard helper didn't start.")), 20000);
      ps.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i; while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line === "@@ready") { clearTimeout(t); ok(); continue; }
          const m = /^@@(\d+) (.*)$/.exec(line); if (!m) continue;
          const w = waiting.get(+m[1]); if (!w) continue;
          waiting.delete(+m[1]);
          let j = {}; try { j = JSON.parse(m[2]); } catch {}
          j.error ? w.no(new Error(j.error)) : w.ok(j);
        }
      });
      ps.on("exit", () => { clearTimeout(t); for (const w of waiting.values()) w.no(new Error("The mouse and keyboard helper stopped.")); waiting.clear(); ps = null; });
      ps.on("error", (e) => { clearTimeout(t); no(e); });
    });
    return ready;
  }
  async function call(cmd, arg) {
    await start();
    const id = ++seq;
    return new Promise((ok, no) => {
      const t = setTimeout(() => { waiting.delete(id); no(new Error("The move took too long.")); }, 20000);
      waiting.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, no: (e) => { clearTimeout(t); no(e); } });
      ps.stdin.write(JSON.stringify({ id, cmd, arg }) + "\n");
    });
  }
  return {
    click: (x, y, button = "left", count = 1) => call("click", { x: Math.round(x), y: Math.round(y), button, count }),
    scroll: (x, y, amount) => call("scroll", { x: Math.round(x), y: Math.round(y), amount: Math.max(-20, Math.min(20, Math.round(amount) || -3)) }),
    type: (text) => call("type", { text: String(text).slice(0, 4000) }),
    keys: (combo) => call("keys", { vks: parseCombo(combo) }),
    focus: (hwnd) => (hwnd ? call("focus", { hwnd: Number(hwnd) }) : Promise.resolve()),
    stop() { if (ps) { try { ps.kill(); } catch {} ps = null; } },
  };
}
module.exports = { create, parseCombo };
