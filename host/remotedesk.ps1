# Remote desktop: the PC's screen as pictures, and the mouse and keyboard from another device. Run by the desktop helper
# (desktop.js) in the signed-in Windows session, in its own PowerShell, so a stream of pictures never holds up the Hub's
# commands. One request per line on stdin (JSON), one answer per line on stdout: "@@<id> <json>".
#   screens                                   the displays, in physical pixels
#   shot  { x, y, w, h, max, q }              that part of the desktop (with the mouse pointer drawn in), shrunk to at most
#                                             max pixels wide, as JPEG quality q: { w, h, img }
#   move / down / up / click / wheel { x, y, button, count, dy }      the mouse, at physical screen pixels
#   key   { vk, down }   combo { vks }   text { text }                 the keyboard
#   touch { pts: [{ id, x, y, s }] }          fingers (id 0..9, s: 0 down, 1 moved, 2 up) as Windows touch input; where Windows
#                                             can't take that, the first finger is the mouse
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
  // ---------- fingers: Windows touch input, as from a touchscreen (Windows hides the mouse pointer while you touch) ----------
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] struct PINFO { public int type; public uint id; public uint frame; public uint flags; public IntPtr device; public IntPtr hwnd; public POINT px; public POINT him; public POINT pxRaw; public POINT himRaw; public uint time; public uint history; public int data; public uint keys; public ulong perf; public int button; }
  [StructLayout(LayoutKind.Sequential)] struct PTOUCH { public PINFO p; public uint tflags; public uint mask; public RECT contact; public RECT contactRaw; public uint orientation; public uint pressure; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool InitializeTouchInjection(uint max, uint mode);
  [DllImport("user32.dll", SetLastError = true)] static extern bool InjectTouchInput(uint n, [In] PTOUCH[] c);
  public static int TouchSize() { return Marshal.SizeOf(typeof(PTOUCH)); }
  static int touchWay = 0; static bool[] tDown = new bool[10]; static int[] tX = new int[10], tY = new int[10]; static int mouseFinger = -1;
  static PTOUCH Finger(int id, int x, int y, int s) {
    var c = new PTOUCH(); c.p.type = 2; c.p.id = (uint)id; c.p.px.X = x; c.p.px.Y = y;
    c.p.flags = s == 0 ? 0x10006u : s == 1 ? 0x20006u : 0x40000u;     // down|in range|in contact, update|in range|in contact, up
    return c;
  }
  public static string Touch(int[] ids, int[] xs, int[] ys, int[] st) {
    if (touchWay == 0) touchWay = InitializeTouchInjection(10, 1) ? 1 : -1;
    if (touchWay == 1) {
      var list = new System.Collections.Generic.List<PTOUCH>(); var seen = new bool[10];
      for (int i = 0; i < ids.Length; i++) {
        int id = ids[i], s = st[i]; if (id < 0 || id > 9 || seen[id]) continue;
        if (s == 0 && tDown[id]) s = 1;          // already down: a move
        if (s != 0 && !tDown[id]) continue;      // never down: nothing to move or lift
        seen[id] = true; tX[id] = xs[i]; tY[id] = ys[i]; list.Add(Finger(id, xs[i], ys[i], s));
      }
      for (int id = 0; id < 10; id++) if (tDown[id] && !seen[id]) list.Add(Finger(id, tX[id], tY[id], 1));    // every finger that's down, in each frame
      if (list.Count == 0) return "touch";
      var a = list.ToArray();
      if (InjectTouchInput((uint)a.Length, a)) { foreach (var c in a) tDown[c.p.id] = c.p.flags != 0x40000u; return "touch"; }
      // Windows didn't take it: the mouse from now on
      touchWay = -1; Array.Clear(tDown, 0, 10);
    }
    for (int i = 0; i < ids.Length; i++) {
      int id = ids[i], s = st[i];
      if (s == 0 && mouseFinger < 0) { mouseFinger = id; SetCursorPos(xs[i], ys[i]); Send(new INPUT[] { M(2, 0) }); }
      else if (id == mouseFinger && s == 1) SetCursorPos(xs[i], ys[i]);
      else if (id == mouseFinger && s == 2) { SetCursorPos(xs[i], ys[i]); Send(new INPUT[] { M(4, 0) }); mouseFinger = -1; }
    }
    return "mouse";
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
  // ---------- the PC's own mouse pointer: hidden while someone uses the PC remotely with a mouse, or behind the cover ----------
  // Every standard Windows pointer becomes an empty one (so it's neither on the monitor nor in the video, and the other device shows
  // its own pointer, without delay); showing it again reloads the pointers chosen in Windows. Never lasting: signing out or
  // restarting brings them back too.
  [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr inst, int x, int y, int w, int h, byte[] and, byte[] xor);
  [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr cur, uint id);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint p, IntPtr v, uint ini);
  static readonly uint[] POINTERS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };
  public static void Pointer(bool hide) {
    if (!hide) { SystemParametersInfo(0x57, 0, IntPtr.Zero, 0); return; }      // SPI_SETCURSORS
    byte[] and = new byte[128], xor = new byte[128];
    for (int i = 0; i < 128; i++) and[i] = 0xFF;                               // 32x32, every pixel see-through
    foreach (uint id in POINTERS) SetSystemCursor(CreateCursor(IntPtr.Zero, 0, 0, 32, 32, and, xor), id);
  }
  // ---------- HDR: off while the screen goes out as video (an HDR desktop comes out washed out and blooming in the video) ----------
  // Every monitor that has HDR on gets it switched off (Windows' own setting, as in Settings → Display), and back on afterwards.
  // Which ones is also kept in a file, so a copy of this that was ended by force still gets them back the next time it starts.
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, IntPtr paths, ref uint nm, IntPtr modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr pkt);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr pkt);
  static readonly string HdrFile = System.IO.Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Albatross", "hdr-off.txt");
  static System.Collections.Generic.List<int[]> hdrOff = new System.Collections.Generic.List<int[]>();
  static void Head(IntPtr g, int type, int size, int[] t) { Marshal.WriteInt32(g, 0, type); Marshal.WriteInt32(g, 4, size); Marshal.WriteInt32(g, 8, t[0]); Marshal.WriteInt32(g, 12, t[1]); Marshal.WriteInt32(g, 16, t[2]); }
  static bool SetHdr(int[] t, bool on) {
    IntPtr g = Marshal.AllocHGlobal(24);
    try { Head(g, 10, 24, t); Marshal.WriteInt32(g, 20, on ? 1 : 0); return DisplayConfigSetDeviceInfo(g) == 0; } finally { Marshal.FreeHGlobal(g); }   // SET_ADVANCED_COLOR_STATE
  }
  // off: switches HDR off where it's on and says how many; on: switches those back on
  public static int Hdr(bool off) {
    if (!off) {
      if (hdrOff.Count == 0) try { foreach (var l in System.IO.File.ReadAllLines(HdrFile)) { var p = l.Split(','); if (p.Length == 3) hdrOff.Add(new int[] { int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]) }); } } catch { }
      int back = 0; foreach (var t in hdrOff) if (SetHdr(t, true)) back++;
      hdrOff.Clear(); try { System.IO.File.Delete(HdrFile); } catch { }
      return back;
    }
    uint np, nm; if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return 0;          // QDC_ONLY_ACTIVE_PATHS
    IntPtr paths = Marshal.AllocHGlobal((int)(72 * np)), modes = Marshal.AllocHGlobal((int)(64 * nm)), g = Marshal.AllocHGlobal(32);
    int n = 0;
    try {
      if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return 0;
      for (int i = 0; i < np; i++) {
        int o = i * 72 + 20, lo = Marshal.ReadInt32(paths, o), hi = Marshal.ReadInt32(paths, o + 4), id = Marshal.ReadInt32(paths, o + 8);   // the path's target
        int[] t = new int[] { lo, hi, id };
        if (hdrOff.Exists(x => x[0] == lo && x[1] == hi && x[2] == id)) continue;
        Head(g, 9, 32, t); for (int k = 20; k < 32; k += 4) Marshal.WriteInt32(g, k, 0);                                // GET_ADVANCED_COLOR_INFO
        if (DisplayConfigGetDeviceInfo(g) != 0 || (Marshal.ReadInt32(g, 20) & 2) == 0) continue;                         // advancedColorEnabled
        if (SetHdr(t, false)) { hdrOff.Add(t); n++; }
      }
      if (hdrOff.Count > 0) try { System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(HdrFile)); System.IO.File.WriteAllLines(HdrFile, hdrOff.ConvertAll(x => x[0] + "," + x[1] + "," + x[2]).ToArray()); } catch { }
    } finally { Marshal.FreeHGlobal(paths); Marshal.FreeHGlobal(modes); Marshal.FreeHGlobal(g); }
    return n;
  }
}
'@
[void][AlbDesk]::SetProcessDPIAware()
# a pointer left hidden by a copy of this that was ended by force comes back now
[AlbDesk]::Pointer($false)
[void][AlbDesk]::Hdr($false)
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
      "touch" { $p = @($a.pts); $out = '{"via":"' + [AlbDesk]::Touch([int[]]@($p.id), [int[]]@($p.x), [int[]]@($p.y), [int[]]@($p.s)) + '"}' }
      "key" { [AlbDesk]::Key([uint16](Num $a.vk), [bool]$a.down) }
      "combo" { [AlbDesk]::Combo([uint16[]]@($a.vks)) }
      "text" { [AlbDesk]::Text([string]$a.text) }
      "pointer" { [AlbDesk]::Pointer([bool]$a.hide) }
      "hdr" { $out = '{"changed":' + [AlbDesk]::Hdr([bool]$a.off) + '}' }
      default { throw "Unknown remote desktop command" }
    }
    [Console]::Out.WriteLine("@@" + $id + " " + $out)
  } catch { [Console]::Out.WriteLine("@@" + $id + " " + (ConvertTo-Json -Compress @{ error = ($_.Exception.Message -replace "[\r\n]+", " ") })) }
}
# the app closed this (or went away): the pointer comes back
[AlbDesk]::Pointer($false)
[void][AlbDesk]::Hdr($false)
