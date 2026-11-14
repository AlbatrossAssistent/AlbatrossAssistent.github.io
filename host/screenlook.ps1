# One look at the user's screen, for the "help with my screen" feature. Run by the desktop app (it must run in the signed-in desktop
# session: a background session sees a black screen). Prints one line of JSON:
#   { window: { title, proc, x, y, w, h }, screen: { w, h }, image: { b64, w, h, scale }, elements: [ ...see screenmap.ps1 ] }
# The window looked at is the one the user was working in before they came to Albatross: the top window that isn't Albatross
# itself, or the one whose title contains -Window.
param([string]$Window = "", [int]$MaxWidth = 1400, [int]$Limit = 90)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "screenmap.ps1")
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class SL {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public class Win { public long H; public string Title; public uint Pid; public bool Iconic; public bool Cloaked; public bool Tool; }
  // top to bottom, as they are stacked on screen
  public static List<Win> Top() {
    var l = new List<Win>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      l.Add(new Win { H = h.ToInt64(), Title = sb.ToString(), Pid = pid, Iconic = IsIconic(h), Cloaked = cloaked != 0, Tool = (GetWindowLong(h, -20) & 0x80) != 0 });
      return true;
    }, IntPtr.Zero);
    return l;
  }
}
"@
$skipTitles = @('Program Manager', 'Windows Input Experience', 'NVIDIA GeForce Overlay', 'Microsoft Text Input Application', 'Settings Window', 'Albatross overlay', 'Albatross warning')
$skipProcs = @('Albatross', 'TextInputHost', 'SearchHost', 'StartMenuExperienceHost', 'ShellExperienceHost', 'LockApp')
$procCache = @{}
function Proc-Name([uint32]$id) { if (-not $procCache.ContainsKey($id)) { $procCache[$id] = try { (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { '' } }; return $procCache[$id] }
$pick = $null
foreach ($w in [SL]::Top()) {
  if ($w.Iconic -or $w.Cloaked -or $w.Tool -or $skipTitles -contains $w.Title) { continue }
  $pn = Proc-Name $w.Pid
  if ($skipProcs -contains $pn -or $w.Pid -eq $PID) { continue }
  if ($Window -and $w.Title -notlike "*$Window*" -and $pn -notlike "*$Window*") { continue }
  $r = New-Object SM+RECT; [void][SM]::GetWindowRect([IntPtr]$w.H, [ref]$r)
  if (($r.R - $r.L) -lt 120 -or ($r.B - $r.T) -lt 80) { continue }
  $pick = [pscustomobject]@{ H = $w.H; Title = $w.Title; Proc = $pn; L = $r.L; T = $r.T; R = $r.R; B = $r.B }
  break
}
if (-not $pick) { Write-Output (ConvertTo-Json -Compress -InputObject @{ error = $(if ($Window) { "I couldn't find a window called '$Window'." } else { "There is no other window open to look at." }) }); exit 0 }
$sw = [SM]::ScreenW(); $sh = [SM]::ScreenH()
$x0 = [Math]::Max(0, $pick.L); $y0 = [Math]::Max(0, $pick.T); $w = [Math]::Min($pick.R, $sw) - $x0; $h = [Math]::Min($pick.B, $sh) - $y0
# the window's own pixels (even where other windows cover it), cut to the part that is on screen, shrunk for the model, as a JPEG
$full = [SM]::Capture($pick.H, $pick.R - $pick.L, $pick.B - $pick.T, $pick.L, $pick.T)
$crop = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($crop); $g.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle(($x0 - $pick.L), ($y0 - $pick.T), $w, $h)), [System.Drawing.GraphicsUnit]::Pixel); $g.Dispose(); $full.Dispose()
$scale = [Math]::Min(1.0, $MaxWidth / [double]$w); $tw = [int]($w * $scale); $th = [int]($h * $scale)
$small = New-Object System.Drawing.Bitmap($tw, $th)
$g = [System.Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($crop, 0, 0, $tw, $th); $g.Dispose(); $crop.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1); $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
$ms = New-Object System.IO.MemoryStream; $small.Save($ms, $codec, $ep); $small.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray()); $ms.Dispose()
$json = Get-Elements $pick.H $Limit | Out-String
$els = @(); if ($json.Trim()) { $parsed = ConvertFrom-Json $json; $els = @($parsed) }
Write-Output (ConvertTo-Json -Compress -Depth 6 -InputObject @{
  window = @{ title = $pick.Title; proc = $pick.Proc; x = $x0; y = $y0; w = $w; h = $h }
  screen = @{ w = $sw; h = $sh }
  image = @{ b64 = $b64; w = $tw; h = $th; scale = $scale }
  elements = $els
})
