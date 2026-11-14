# Reads the text out of a picture or a scanned PDF with the text reader built into Windows (Windows.Media.Ocr), on this PC.
# Used by "Ask your documents" (host/docs.js) for files that have no text of their own: photos of pages, scans, screenshots.
#   -File <path>              a .png/.jpg/.jpeg/.bmp/.gif/.tif/.tiff picture, or a .pdf
#   -Pages "2,5"              for a PDF: only these pages (1-based); empty = every page (at most 200)
# Prints one line of JSON: {"pages":[{"page":1,"text":"..."}], "lang":"de-DE"}  or  {"error":"..."}
param([Parameter(Mandatory = $true)][string]$File, [string]$Pages = "")
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Foundation, ContentType = WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $asOp = ($ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asAct = ($ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  function Await($op, $type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  function AwaitAction($op) { $t = $asAct.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

  $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $eng) { throw "Windows has no text reader for your languages. Add one in Settings, Time & language, Language (with 'Optical character recognition')." }
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

  function Read-Bitmap($stream) {
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($sb.PixelWidth -gt $max -or $sb.PixelHeight -gt $max) { return "" }   # too big to read in one go (rare: a poster-sized scan)
    $res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    (($res.Lines | ForEach-Object { $_.Text }) -join "`n")
  }

  $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($File))) ([Windows.Storage.StorageFile])
  $out = New-Object System.Collections.ArrayList
  if ($File -match '\.pdf$') {
    $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($sf)) ([Windows.Data.Pdf.PdfDocument])
    $want = if ($Pages.Trim()) { $Pages -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ } } else { 1..([Math]::Min($doc.PageCount, 200)) }
    foreach ($n in $want) {
      if ($n -lt 1 -or $n -gt $doc.PageCount) { continue }
      $page = $doc.GetPage([uint32]($n - 1))
      $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      # about 200 dpi on a normal page: small print still reads, and it stays under the reader's size limit
      $w = [Math]::Min([double]$max, [Math]::Max(1200.0, $page.Size.Width * 2.8))
      $opt.DestinationWidth = [uint32]$w
      $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      AwaitAction ($page.RenderToStreamAsync($ms, $opt))
      $text = Read-Bitmap $ms
      $page.Dispose(); $ms.Dispose()
      [void]$out.Add(@{ page = $n; text = $text })
    }
  } else {
    $stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    [void]$out.Add(@{ page = 0; text = (Read-Bitmap $stream) })
    $stream.Dispose()
  }
  @{ pages = @($out); lang = $eng.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
