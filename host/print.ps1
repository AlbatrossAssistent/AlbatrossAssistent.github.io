# Prints one file without opening any app, so it also works when the host runs in Windows' background session (started at boot,
# no desktop), where an app's own "Print" (Notepad, Photos, a PDF reader) can't show up or print at all.
#   text (txt, md, csv, log, json)      drawn as text, wrapped and split into pages
#   pictures (png, jpg, bmp, gif)       fitted onto the page, turned sideways when wider than tall
#   pdf                                 each page drawn by Windows' own PDF reader (Windows.Data.Pdf), then printed like a picture
#   Word, Excel, PowerPoint, html, rtf  turned into a PDF by Office first, then printed like a PDF
# In:  $env:AP_FILE (the file), $env:AP_PRINTER (printer name), $env:AP_OUT (optional: a file to print into, for "Print to PDF")
# Out: one line of JSON, {"pages": n}
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$file = $env:AP_FILE; $printer = $env:AP_PRINTER; $out = $env:AP_OUT
$ext = [IO.Path]::GetExtension($file).TrimStart(".").ToLower()
$temp = Join-Path ([IO.Path]::GetTempPath()) ("albatross-print-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null

# ---- Office files and web pages become a PDF first ----
# The conversion runs as its own little script (convert.ps1 next to this one) with Office in a background job: called straight
# from a script, Word's save as PDF never returns (it does in a job). Office can't open documents in Windows' background
# session (no desktop), so there the script is run on the signed-in desktop by a one-time scheduled task, hidden.
function OfficeToPdf([string]$path) {
  $pdf = Join-Path $temp "doc.pdf"
  $convert = Join-Path $PSScriptRoot "convert.ps1"
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $convert -Path $path -Pdf $pdf -Ext $ext 2>&1 | Out-Null
  } else {
    $user = (Get-CimInstance Win32_ComputerSystem).UserName
    if (-not $user) { throw "Office files can only be printed while someone is signed in on the PC (text, pictures and PDFs always work)." }
    $vbs = Join-Path $temp "run.vbs"
    $cmd = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$convert"" -Path ""$path"" -Pdf ""$pdf"" -Ext $ext"
    Set-Content -Path $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "' + $cmd.Replace('"', '""') + '", 0, True')
    $task = "Albatross print " + [guid]::NewGuid().ToString("N").Substring(0, 8)
    & schtasks /Create /TN $task /TR "wscript.exe `"$vbs`"" /SC ONCE /ST 23:59 /IT /F 2>&1 | Out-Null
    try {
      & schtasks /Run /TN $task 2>&1 | Out-Null
      $until = (Get-Date).AddSeconds(150)
      while (-not (Test-Path (Join-Path $temp "done.txt")) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 400 }
    } finally { & schtasks /Delete /TN $task /F 2>&1 | Out-Null }
  }
  $done = Join-Path $temp "done.txt"
  $msg = if (Test-Path $done) { (Get-Content $done -Raw).Trim() } else { "" }
  if (-not (Test-Path $pdf)) { throw "Office couldn't turn it into a PDF to print" + $(if ($msg -and $msg -ne "ok") { ": $msg" } elseif (-not $msg) { " (it took too long)." } else { "." }) }
  return $pdf
}

# ---- PDF pages as pictures, through Windows' own PDF reader ----
$script:pdfDoc = $null
function Await($op, [Type]$type) {
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $t = $m.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; return $t.Result
}
function AwaitAction($op) {
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" } | Select-Object -First 1
  $m.Invoke($null, @($op)).Wait(-1) | Out-Null
}
function OpenPdf([string]$path) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $script:pdfDoc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($f)) ([Windows.Data.Pdf.PdfDocument])
  return [int]$script:pdfDoc.PageCount
}
function PdfPageImage([int]$i) {
  $page = $script:pdfDoc.GetPage([uint32]$i)
  $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opt.DestinationWidth = [uint32][Math]::Min(2400, $page.Size.Width * 200 / 72)    # about 200 dpi
  $s = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($page.RenderToStreamAsync($s, $opt))
  $page.Dispose()
  return [System.Drawing.Image]::FromStream([System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($s))
}

# ---- what to print: a list of picture pages, or text ----
$script:pages = 0; $script:text = $null; $script:imgCount = 0; $script:getImage = $null
if ($ext -match "^(txt|md|csv|log|json)$") {
  $script:text = ([IO.File]::ReadAllText($file)).Replace("`r`n", "`n").Replace("`t", "    ")
  if (-not $script:text.Trim()) { throw "The file is empty." }
} elseif ($ext -match "^(png|jpe?g|bmp|gif)$") {
  $script:imgCount = 1; $script:getImage = { param($i) [System.Drawing.Image]::FromFile($file) }
} else {
  $pdfPath = if ($ext -eq "pdf") { $file } else { OfficeToPdf $file }
  $script:imgCount = OpenPdf $pdfPath
  if ($script:imgCount -lt 1) { throw "The PDF has no pages." }
  $script:getImage = { param($i) PdfPageImage $i }
}

$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.DocumentName = [IO.Path]::GetFileName($file)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController   # no "printing page 1" window
$doc.PrinterSettings.PrinterName = $printer
if (-not $doc.PrinterSettings.IsValid) { throw "The printer `"$printer`" can't be used." }
if ($out) { $doc.PrinterSettings.PrintToFile = $true; $doc.PrinterSettings.PrintFileName = $out }
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(40, 40, 40, 40)   # 0.4 inch
$script:i = 0; $script:img = $null
$font = New-Object System.Drawing.Font("Consolas", 9.5)
$fmt = New-Object System.Drawing.StringFormat; $fmt.Trimming = [System.Drawing.StringTrimming]::Word

# pictures wider than tall go on a sideways page
$doc.add_QueryPageSettings({
  param($s, $e)
  if ($script:imgCount -gt 0 -and $script:i -lt $script:imgCount) {
    $script:img = & $script:getImage $script:i
    $e.PageSettings.Landscape = $script:img.Width -gt $script:img.Height
  }
})
$doc.add_PrintPage({
  param($s, $e)
  $r = $e.MarginBounds
  if ($null -ne $script:text) {
    $chars = 0; $lines = 0
    [void]$e.Graphics.MeasureString($script:text, $font, (New-Object System.Drawing.SizeF($r.Width, $r.Height)), $fmt, [ref]$chars, [ref]$lines)
    $e.Graphics.DrawString($script:text, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($r.X, $r.Y, $r.Width, $r.Height)), $fmt)
    $script:text = $script:text.Substring([Math]::Max(1, $chars))
    $script:pages++
    $e.HasMorePages = $script:text.Length -gt 0
  } else {
    $img = $script:img
    $k = [Math]::Min($r.Width / $img.Width, $r.Height / $img.Height)
    $w = $img.Width * $k; $h = $img.Height * $k
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.DrawImage($img, [float]($r.X + ($r.Width - $w) / 2), [float]($r.Y + ($r.Height - $h) / 2), [float]$w, [float]$h)
    $img.Dispose(); $script:img = $null
    $script:i++; $script:pages++
    $e.HasMorePages = $script:i -lt $script:imgCount
  }
})
try { $doc.Print() } finally { if ($script:pdfDoc) { $script:pdfDoc = $null }; Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
Write-Output ("{""pages"":" + $script:pages + "}")
