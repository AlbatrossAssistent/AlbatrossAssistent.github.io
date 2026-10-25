# Turns an Office file (or a web page or rtf, through Word) into a PDF, for print.ps1. Writes done.txt next to the PDF when it
# is finished: "ok", or what went wrong. Office runs in a background job, since Word's save as PDF never returns when it is
# called straight from a script; it gets two minutes, and an Office program left running without a window is closed.
param([string]$Path, [string]$Pdf, [string]$Ext)
$done = Join-Path (Split-Path $Pdf) "done.txt"
$started = Get-Date
$job = Start-Job -ArgumentList $Path, $Pdf, $Ext -ScriptBlock {
  param($path, $pdf, $ext)
  $ErrorActionPreference = "Stop"
  switch -Regex ($ext) {
    "^(docx?|rtf|html?|odt)$" {
      $w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
      # SaveAs2 as PDF (17), not ExportAsFixedFormat, which doesn't return when called from PowerShell
      try { $d = $w.Documents.Open($path, $false, $true, $false); $d.SaveAs2($pdf, 17); $d.Close(0) } finally { $w.Quit() }
    }
    "^(xlsx?|ods)$" {
      $x = New-Object -ComObject Excel.Application; $x.Visible = $false; $x.DisplayAlerts = $false
      try { $b = $x.Workbooks.Open($path, 0, $true); $b.ExportAsFixedFormat(0, $pdf); $b.Close($false) }
      finally { $x.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($x); [GC]::Collect(); [GC]::WaitForPendingFinalizers() }   # else Excel stays in memory
    }
    "^(pptx?|odp)$" {
      $p = New-Object -ComObject PowerPoint.Application
      try { $s = $p.Presentations.Open($path, -1, 0, 0); $s.SaveAs($pdf, 32); $s.Close() } finally { $p.Quit() }
    }
  }
}
$finished = Wait-Job $job -Timeout 120
$err = if ($job.ChildJobs[0].Error.Count) { $job.ChildJobs[0].Error[0].ToString() } elseif ($job.ChildJobs[0].JobStateInfo.Reason) { $job.ChildJobs[0].JobStateInfo.Reason.Message } else { "" }
Remove-Job $job -Force
Start-Sleep -Milliseconds 300
# one this started and that shows no window title is ours and hidden (an Office window the user opens has a title)
Get-Process WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $started -and -not $_.MainWindowTitle } | Stop-Process -Force -ErrorAction SilentlyContinue
$result = if (-not $finished) { "Office took too long to open the file." } elseif (Test-Path $Pdf) { "ok" } elseif ($err) { $err } else { "Office didn't make a PDF." }
Set-Content -Path $done -Value $result -Encoding UTF8
