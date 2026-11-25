; Albatross keeps working when its window is closed: the host (the part your phone talks to) and the desktop helper run as
; Albatross.exe from the install folder, on their own, with PowerShell helpers they started. With "Start at boot" on, the host
; is started by the "Burrow host" task with admin rights, so this installer (which runs without them) can't end that process
; directly; ending the task can, and it takes the host with it. Their open files used to stop updates with "Failed to
; uninstall old application files". So before the old version is removed: the boot task is ended, the PowerShell helpers
; and every other Albatross.exe are ended (never the installer itself, which Albatross may have started), and the installer
; waits a moment until Windows lets go of the files. The new version starts them all again; the boot task runs again at the
; next start of the PC.
; ($$ is a plain $ for PowerShell: NSIS reads $ as its own variables.)
!macro customInit
  nsExec::Exec `schtasks /End /TN "Burrow host"`
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ids = @(Get-Process -Name Albatross -ErrorAction SilentlyContinue | ForEach-Object Id); Get-CimInstance Win32_Process | Where-Object { $$ids -contains $$_.ParentProcessId -and $$_.Name -notmatch 'Albatross|Setup|install' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$ids | ForEach-Object { Stop-Process -Id $$_ -Force -ErrorAction SilentlyContinue }"`
  nsExec::Exec `taskkill /F /IM Albatross.exe`
  Sleep 2000
!macroend
