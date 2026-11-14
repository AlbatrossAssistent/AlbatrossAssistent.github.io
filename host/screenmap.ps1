# Screen map: the things in a window you can actually act on, with real positions in screen pixels.
#   1. Windows UI Automation, asked the way a screen reader asks: every element that supports Invoke, Toggle, Select, Expand/Collapse,
#      or takes the keyboard focus (what is "clickable" in reality), plus the usual control types. Browsers and Electron apps
#      keep their page in a child window ("Chrome_RenderWidgetHostHWND") that the outer window doesn't show: it is asked directly,
#      and once more a moment later, because they build their tree on the first question.
#   2. Where that gives (almost) nothing (a game, a canvas, an Electron app with accessibility off), the window's own pixels are
#      read with Windows' built-in text recognition: every line of text becomes a target at its real position.
# The click point of a big element is the point Windows says is clickable, not just the middle of its rectangle.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Runtime.WindowsRuntime
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging;
public class SM {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static int ScreenW() { return GetSystemMetrics(0); }
  public static int ScreenH() { return GetSystemMetrics(1); }
  public static string ClassOf(long h) { var sb = new StringBuilder(128); GetClassName(new IntPtr(h), sb, 128); return sb.ToString(); }
  public static List<KeyValuePair<long,string>> Children(long parent) {
    var l = new List<KeyValuePair<long,string>>();
    EnumChildWindows(new IntPtr(parent), (h, p) => { l.Add(new KeyValuePair<long,string>(h.ToInt64(), ClassOf(h.ToInt64()))); return true; }, IntPtr.Zero);
    return l;
  }
  // the window's own content, even when other windows cover it (PW_RENDERFULLCONTENT = 2); falls back to the screen region
  public static Bitmap Capture(long hwnd, int w, int h, int sx, int sy) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc(); bool ok = false;
      try { ok = PrintWindow(new IntPtr(hwnd), dc, 2); } finally { g.ReleaseHdc(dc); }
      if (!ok) g.CopyFromScreen(sx, sy, 0, 0, new Size(w, h));
    }
    return bmp;
  }
}
"@
[void][SM]::SetProcessDPIAware()
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$PC = [System.Windows.Automation.PropertyCondition]
$addProp = [System.Windows.Automation.CacheRequest].GetMethod("Add", [Type[]]@([System.Windows.Automation.AutomationProperty]))
$cache = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsOffscreenProperty, $A::IsEnabledProperty, $A::IsKeyboardFocusableProperty,
    $A::IsInvokePatternAvailableProperty, $A::IsTogglePatternAvailableProperty, $A::IsSelectionItemPatternAvailableProperty,
    $A::IsExpandCollapsePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::ClassNameProperty)) { [void]$addProp.Invoke($cache, @(, $p)) }
$core = @($CT::Button, $CT::Edit, $CT::Hyperlink, $CT::MenuItem, $CT::TabItem, $CT::ListItem, $CT::CheckBox, $CT::ComboBox, $CT::RadioButton,
    $CT::TreeItem, $CT::SplitButton, $CT::Slider, $CT::DataItem, $CT::Spinner)
$coreNames = @{}; foreach ($c in $core) { $coreNames[$c.ProgrammaticName.Replace('ControlType.', '')] = $true }
$conds = New-Object System.Collections.ArrayList
foreach ($c in $core) { [void]$conds.Add((New-Object $PC($A::ControlTypeProperty, $c))) }
foreach ($p in @($A::IsInvokePatternAvailableProperty, $A::IsTogglePatternAvailableProperty, $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty, $A::IsKeyboardFocusableProperty)) { [void]$conds.Add((New-Object $PC($p, $true))) }
$wanted = New-Object System.Windows.Automation.OrCondition(([System.Windows.Automation.Condition[]]$conds.ToArray()))
$tooBig = @{ Pane = 1; Group = 1; Window = 1; Document = 1; Custom = 0; Text = 1; Image = 1; List = 1; Tree = 1; Table = 1; ScrollBar = 1; ToolBar = 1; TitleBar = 1; StatusBar = 1; Header = 1; Tab = 1; Menu = 1; MenuBar = 1 }

function Get-Uia([long]$handle, [int]$limit, [bool]$deep = $false) {
  $rootRect = New-Object SM+RECT; [void][SM]::GetWindowRect([IntPtr]$handle, [ref]$rootRect)
  $rootArea = [Math]::Max(1, ($rootRect.R - $rootRect.L) * ($rootRect.B - $rootRect.T))
  $roots = New-Object System.Collections.ArrayList; [void]$roots.Add($handle)
  foreach ($k in [SM]::Children($handle)) { if ($k.Value -eq 'Chrome_RenderWidgetHostHWND') { [void]$roots.Add($k.Key) } }
  $out = New-Object System.Collections.ArrayList; $seen = @{}
  foreach ($h in $roots) {
    $tok = $cache.Activate()
    try {
      $root = $A::FromHandle([IntPtr]$h)
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $(if ($deep) { [System.Windows.Automation.Condition]::TrueCondition } else { $wanted }))
    } catch { continue } finally { $tok.Dispose() }
    foreach ($e in $all) {
      try {
        $c = $e.Cached
        if ($c.IsOffscreen -or -not $c.IsEnabled) { continue }
        $r = $c.BoundingRectangle
        if ([double]::IsInfinity($r.Width) -or $r.Width -lt 5 -or $r.Height -lt 5) { continue }
        $t = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
        $inv = [bool]$e.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty); $tog = [bool]$e.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)
        $sel = [bool]$e.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty); $exp = [bool]$e.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)
        $acts = @(); if ($inv) { $acts += 'click' }; if ($tog) { $acts += 'toggle' }; if ($sel) { $acts += 'select' }; if ($exp) { $acts += 'expand' }
        $name = ("" + $c.Name).Trim()
        $isCore = $coreNames.ContainsKey($t)
        $focus = [bool]$c.IsKeyboardFocusable
        # the deep pass (for a window where the first pass found little): an older Windows program shows its buttons and boxes as
        # plain named "Panes" with no pattern at all. Their window class still says what they are (BUTTON, EDIT, COMBOBOX...), and any
        # small named leaf is most likely a control.
        $legacy = ''
        if ($deep) {
          $cls = "" + $c.ClassName
          if ($cls -match '(?i)(^|\.)BUTTON(\.|$)') { $legacy = 'Button' } elseif ($cls -match '(?i)(^|\.)(RICH)?EDIT\d*W?(\.|$)') { $legacy = 'Edit' } elseif ($cls -match '(?i)COMBOBOX') { $legacy = 'ComboBox' }
          elseif ($cls -match '(?i)SysLink') { $legacy = 'Hyperlink' } elseif ($cls -match '(?i)SysTabControl32') { $legacy = 'TabItem' } elseif ($cls -match '(?i)trackbar') { $legacy = 'Slider' } elseif ($cls -match '(?i)LISTBOX|ComboLBox') { $legacy = 'ListItem' }
        }
        if ($legacy) { $t = $legacy; $isCore = $true }
        $deepNamed = ($deep -and $name -and $r.Width -le 500 -and $r.Height -le 140 -and ($t -eq 'Pane' -or $t -eq 'Group' -or $t -eq 'Custom'))
        # a Pane/Group/Text/Image only counts when it really can be acted on: invoked, toggled, selected, expanded, or given the
        # keyboard focus. That is what a clickable web div or an icon looks like.
        if (-not $isCore -and -not ($inv -or $tog -or $sel -or $exp -or $focus -or $deepNamed)) { continue }
        if (-not $acts.Count -and ($focus -or $deepNamed -or $legacy) -and -not ($t -eq 'Edit' -or $t -eq 'ComboBox')) { $acts += 'click' }
        if (-not $name -and $t -ne 'Edit' -and $t -ne 'ComboBox') { continue }
        if ($r.Width * $r.Height -gt 0.4 * $rootArea -and $t -ne 'Edit') { continue }
        $key = "{0}|{1}|{2}|{3}|{4}" -f $name, [int]($r.X / 6), [int]($r.Y / 6), [int]($r.Width / 6), [int]($r.Height / 6)
        if ($seen.ContainsKey($key)) { continue }; $seen[$key] = $true
        $px = [int]($r.X + $r.Width / 2); $py = [int]($r.Y + $r.Height / 2)
        if (($r.Width -gt 260 -or $r.Height -gt 70) -and $t -ne 'Edit') {
          try { $pt = New-Object System.Windows.Point; if ($e.TryGetClickablePoint([ref]$pt)) { $px = [int]$pt.X; $py = [int]$pt.Y } } catch { }
        }
        # nothing the user can't reach: not a tooltip, not outside its window, not off the screen
        if ($t -eq 'ToolTip') { continue }
        if ($px -lt $rootRect.L -or $px -gt $rootRect.R -or $py -lt $rootRect.T -or $py -gt $rootRect.B -or $px -lt 0 -or $py -lt 0 -or $px -gt [SM]::ScreenW() -or $py -gt [SM]::ScreenH()) { continue }
        $score = 0; if ($inv -or $tog -or $sel -or $exp) { $score += 2 }; if ($isCore) { $score += 1 }; if ($focus) { $score += 1 }
        [void]$out.Add([pscustomobject]@{ t = $t; n = $name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; px = $px; py = $py; a = ($acts -join ','); s = 'ui'; k = $score })
      } catch { }
    }
  }
  return $out
}
function Get-Ocr([long]$handle) {
  $r = New-Object SM+RECT; [void][SM]::GetWindowRect([IntPtr]$handle, [ref]$r)
  $x0 = [Math]::Max(0, $r.L); $y0 = [Math]::Max(0, $r.T)
  $w = [Math]::Min($r.R, [SM]::ScreenW()) - $x0; $h = [Math]::Min($r.B, [SM]::ScreenH()) - $y0
  if ($w -lt 30 -or $h -lt 30) { return @() }
  $bmp = [SM]::Capture($handle, [Math]::Min($w, [Math]::Max(1, $r.R - $r.L)), [Math]::Min($h, [Math]::Max(1, $r.B - $r.T)), $x0, $y0)
  $png = Join-Path $env:TEMP ("alb_ocr_{0}.png" -f [Diagnostics.Process]::GetCurrentProcess().Id)
  try { $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $lines = New-Object System.Collections.ArrayList
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $eng) { return @() }
    $res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $res.Lines) {
      $text = ("" + $line.Text).Trim()
      if ($text.Length -lt 2 -or $text -notmatch '\w') { continue }
      if ($ly -lt 30 -and ($r.T + $ly) -le ($r.T + 30)) { continue }   # the window's own title bar: not something to act on
      $rs = @($line.Words | ForEach-Object { $_.BoundingRect })
      $lx = ($rs | ForEach-Object { $_.X } | Measure-Object -Minimum).Minimum; $ly = ($rs | ForEach-Object { $_.Y } | Measure-Object -Minimum).Minimum
      $rx = ($rs | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum; $ry = ($rs | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
      [void]$lines.Add([pscustomobject]@{ t = 'Text'; n = $text; x = [int]($x0 + $lx); y = [int]($y0 + $ly); w = [int]($rx - $lx); h = [int]($ry - $ly); px = [int]($x0 + ($lx + $rx) / 2); py = [int]($y0 + ($ly + $ry) / 2); a = 'click'; s = 'ocr'; k = 0 })
    }
  } catch { } finally { Remove-Item $png -ErrorAction SilentlyContinue }
  return $lines
}
function Get-Elements([long]$handle, [int]$limit) {
  $found = @(Get-Uia $handle $limit)
  # a browser or Electron window answers the first question with little: it builds the tree now, so ask again
  $cls = [SM]::ClassOf($handle)
  $content = @($found | Where-Object { $_.k -ge 2 }).Count
  if ($content -lt 8 -and ($cls -like 'Chrome_WidgetWin*' -or $cls -like 'MozillaWindowClass*')) { Start-Sleep -Milliseconds 700; $found = @(Get-Uia $handle $limit); $content = @($found | Where-Object { $_.k -ge 2 }).Count }
  $capt = '^(Minimi[sz]e|Maximi[sz]e|Restore|Close|Schlie.en|Minimieren|Maximieren)'
  $usable = @($found | Where-Object { $_.n -notmatch $capt }).Count
  # little found: ask again, looking at every element and its window class (older Windows programs)
  if ($usable -lt 6) {
    foreach ($d in (Get-Uia $handle $limit $true)) {
      $dup = $false
      foreach ($f in $found) { if ([Math]::Abs($f.x - $d.x) -lt 6 -and [Math]::Abs($f.y - $d.y) -lt 6 -and [Math]::Abs($f.w - $d.w) -lt 8 -and [Math]::Abs($f.h - $d.h) -lt 8) { $dup = $true; break } }
      if (-not $dup) { $found += $d }
    }
    $usable = @($found | Where-Object { $_.n -notmatch $capt }).Count
  }
  # still (almost) nothing to act on: read what is written in the window
  if ($usable -lt 6) {
    foreach ($l in (Get-Ocr $handle)) {
      $dup = $false
      foreach ($f in $found) { if ($l.px -ge $f.x -and $l.px -le $f.x + $f.w -and $l.py -ge $f.y -and $l.py -le $f.y + $f.h) { $dup = $true; break } }
      if (-not $dup) { $found += $l }
    }
  }
  $top = @($found | Sort-Object @{ e = { -$_.k } }, @{ e = { [int]($_.y / 28) } }, x | Select-Object -First $limit)
  $ordered = @($top | Sort-Object @{ e = { [int]($_.y / 28) } }, x)
  Write-Output (ConvertTo-Json -InputObject @($ordered | ForEach-Object { @{ t = $_.t; n = $_.n; x = $_.x; y = $_.y; w = $_.w; h = $_.h; px = $_.px; py = $_.py; a = $_.a; s = $_.s } }) -Compress -Depth 3)
}
