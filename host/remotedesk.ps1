# Remote desktop: the PC's screen as pictures, and the mouse and keyboard from another device. Run by the desktop helper
# (desktop.js) in the signed-in Windows session, in its own PowerShell, so a stream of pictures never holds up the Hub's
# commands. One request per line on stdin (JSON), one answer per line on stdout: "@@<id> <json>".
#   screens                                   the displays, in physical pixels
#   shot  { x, y, w, h, max, q }              that part of the desktop (with the mouse pointer drawn in), shrunk to at most
#                                             max pixels wide, as JPEG quality q: { w, h, img }
#   move / down / up / click / wheel { x, y, button, count, dy }      the mouse, at physical screen pixels
#   key   { vk, down }   combo { vks }   text { text }                 the keyboard
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading; using System.Drawing; using System.Drawing.Imaging; using System.IO;
public class AlbDesk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHot; public int yHot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public U u; }
  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  static ImageCodecInfo jpeg = null;

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr w, IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr d, int dx, int dy, int dw, int dh, IntPtr s, int sx, int sy, int sw, int sh, int rop);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int dx, int dy, int dw, int dh, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
  [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr old);
  // the picture of the last size, kept between frames (no new bitmap 10 times a second), and a fingerprint of the last frame:
  // an unchanged screen isn't encoded again
  static Bitmap pic = null; static long lastSum = 0; static string lastOut = "";
  // Copies and shrinks the screen in one step (StretchBlt, HALFTONE: smooth, not blocky) instead of copying the whole screen at
  // full size first and shrinking that: on a 2560x1440 screen about half the time per frame.
  public static string Shot(int x, int y, int w, int h, int max, long q) {
    double k = Math.Min(1.0, (double)max / w); int tw = Math.Max(1, (int)(w * k)), th = Math.Max(1, (int)(h * k));
    if (pic == null || pic.Width != tw || pic.Height != th) { if (pic != null) pic.Dispose(); pic = new Bitmap(tw, th, PixelFormat.Format24bppRgb); lastOut = ""; }
    IntPtr screen = GetDC(IntPtr.Zero);
    try {
      using (var g = Graphics.FromImage(pic)) {
        var hdc = g.GetHdc();
        try {
          if (k < 1) { SetStretchBltMode(hdc, 4); SetBrushOrgEx(hdc, 0, 0, IntPtr.Zero); StretchBlt(hdc, 0, 0, tw, th, screen, x, y, w, h, 0x00CC0020); }
          else BitBlt(hdc, 0, 0, tw, th, screen, x, y, 0x00CC0020);
          // the mouse pointer isn't in a screen copy: draw it in (at its normal size, so it stays easy to see on a small picture)
          var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
          if (GetCursorInfo(ref ci) && ci.flags == 1) {
            ICONINFO ii; int hx = 0, hy = 0;
            if (GetIconInfo(ci.hCursor, out ii)) { hx = ii.xHot; hy = ii.yHot; if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask); if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor); }
            DrawIconEx(hdc, (int)((ci.pt.X - x) * k) - hx, (int)((ci.pt.Y - y) * k) - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
          }
        } finally { g.ReleaseHdc(hdc); }
      }
    } finally { ReleaseDC(IntPtr.Zero, screen); }
    // fingerprint: every 7th 64-bit word of the pixels; the same as last time = the same picture, no need to encode it
    var bd = pic.LockBits(new Rectangle(0, 0, tw, th), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    long sum = 0;
    try { int n = bd.Stride * th / 8; for (int i = 0; i < n; i += 7) sum = sum * 31 + Marshal.ReadInt64(bd.Scan0, i * 8); } finally { pic.UnlockBits(bd); }
    if (sum == lastSum && lastOut != "") return lastOut;
    lastSum = sum;
    if (jpeg == null) foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    var ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
    using (var ms = new MemoryStream()) { pic.Save(ms, jpeg, ep); lastOut = tw + "," + th + "," + Convert.ToBase64String(ms.ToArray()); return lastOut; }
  }
  static uint Down(string b) { return b == "right" ? 8u : b == "middle" ? 32u : 2u; }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Press(int x, int y, string b, bool down) { SetCursorPos(x, y); Send(new INPUT[] { M(down ? Down(b) : Down(b) * 2, 0) }); }
  public static void Click(int x, int y, string b, int count) { SetCursorPos(x, y); Thread.Sleep(20); for (int c = 0; c < Math.Max(1, Math.Min(3, count)); c++) { Send(new INPUT[] { M(Down(b), 0), M(Down(b) * 2, 0) }); Thread.Sleep(40); } }
  public static void Wheel(int x, int y, int dy, bool horizontal) { SetCursorPos(x, y); Send(new INPUT[] { M(horizontal ? 0x1000u : 0x0800u, (uint)dy) }); }
  static bool Ext(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90; }
  public static void Key(ushort vk, bool down) { Send(new INPUT[] { K(vk, 0, (Ext(vk) ? 1u : 0u) | (down ? 0u : 2u)) }); }
  public static void Combo(ushort[] vks) {
    foreach (var vk in vks) { Key(vk, true); Thread.Sleep(15); }
    for (int i = vks.Length - 1; i >= 0; i--) { Key(vks[i], false); Thread.Sleep(15); }
  }
  public static void Text(string s) {
    foreach (char ch in s) {
      if (ch == '\n') Combo(new ushort[] { 0x0D });
      else if (ch == '\t') Combo(new ushort[] { 0x09 });
      else if (ch != '\r') Send(new INPUT[] { K(0, ch, 4), K(0, ch, 4 | 2) });
      Thread.Sleep(4);
    }
  }
}
'@
[void][AlbDesk]::SetProcessDPIAware()
[Console]::Out.WriteLine("@@ready")
function Num($v, $d = 0) { if ($null -eq $v) { return $d }; return [int]$v }
while ($true) {
  $line = [Console]::In.ReadLine(); if ($null -eq $line) { break }
  $id = ""
  try {
    $j = ConvertFrom-Json $line; $id = $j.id; $a = $j.arg; $out = '{"ok":true}'
    switch ($j.cmd) {
      "screens" {
        $i = 0
        $list = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b = $_.Bounds; @{ i = $i++; primary = $_.Primary; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height; name = $_.DeviceName } })
        $out = ConvertTo-Json -Compress -Depth 3 @{ screens = $list }
      }
      "shot" {
        $r = [AlbDesk]::Shot((Num $a.x), (Num $a.y), (Num $a.w 1280), (Num $a.h 720), (Num $a.max 1280), [long](Num $a.q 60))
        $p = $r.Split(",", 3); $out = '{"w":' + $p[0] + ',"h":' + $p[1] + ',"img":"' + $p[2] + '"}'
      }
      "move" { [AlbDesk]::Move((Num $a.x), (Num $a.y)) }
      "down" { [AlbDesk]::Press((Num $a.x), (Num $a.y), [string]$a.button, $true) }
      "up" { [AlbDesk]::Press((Num $a.x), (Num $a.y), [string]$a.button, $false) }
      "click" { [AlbDesk]::Click((Num $a.x), (Num $a.y), [string]$a.button, (Num $a.count 1)) }
      "wheel" { [AlbDesk]::Wheel((Num $a.x), (Num $a.y), (Num $a.dy), [bool]$a.horizontal) }
      "key" { [AlbDesk]::Key([uint16](Num $a.vk), [bool]$a.down) }
      "combo" { [AlbDesk]::Combo([uint16[]]@($a.vks)) }
      "text" { [AlbDesk]::Text([string]$a.text) }
      default { throw "Unknown remote desktop command" }
    }
    [Console]::Out.WriteLine("@@" + $id + " " + $out)
  } catch { [Console]::Out.WriteLine("@@" + $id + " " + (ConvertTo-Json -Compress @{ error = ($_.Exception.Message -replace "[\r\n]+", " ") })) }
}
