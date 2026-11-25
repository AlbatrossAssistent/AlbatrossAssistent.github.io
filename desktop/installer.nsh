; Albatross keeps working when its window is closed: the host (the part your phone talks to) and the desktop helper run as
; Albatross.exe from the install folder, on their own, with PowerShell helpers they started. Their open files and folders used
; to stop updates with "Failed to uninstall old application files". So before the old version is removed, those helpers and
; every Albatross.exe are ended (never the installer itself, which Albatross may have started), and the installer waits a
; moment until Windows lets go of the files. The new version starts them all again.
; ($$ is a plain $ for PowerShell: NSIS reads $ as its own variables.)
!macro customInit
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ids = @(Get-Process -Name Albatross -ErrorAction SilentlyContinue | ForEach-Object Id); Get-CimInstance Win32_Process | Where-Object { $$ids -contains $$_.ParentProcessId -and $$_.Name -notmatch 'Albatross|Setup|install' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$ids | ForEach-Object { Stop-Process -Id $$_ -Force -ErrorAction SilentlyContinue }"`
  nsExec::Exec `taskkill /F /IM Albatross.exe`
  Sleep 1500
!macroend
