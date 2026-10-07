# Turns Burrow's start-at-boot on or off. Use autostart-on.bat / autostart-off.bat instead of running this directly.
# "install" creates a Windows scheduled task that runs host\background.js at boot under YOUR account,
# even before you sign in. Windows asks for your password in its own dialog and stores it for the task.
param([ValidateSet("install", "uninstall")][string]$Action = "install")
$ErrorActionPreference = "Stop"
$TaskName = "Burrow host"
$root = Split-Path -Parent $PSScriptRoot

if ($Action -eq "uninstall") {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Start-at-boot is off. Burrow will only run when you start burrow-host.bat."
  } else { Write-Host "Start-at-boot wasn't turned on." }
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js wasn't found. Install it from https://nodejs.org and try again." }
$state = Join-Path $PSScriptRoot "host-code.json"
if (-not (Test-Path $state) -or -not (Get-Content $state -Raw | ConvertFrom-Json).server) {
  throw "Start burrow-host.bat once first, so Burrow knows your server and code."
}

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host ""
Write-Host "To start Burrow before you sign in, Windows needs your account password."
Write-Host "It is stored by Windows Task Scheduler, not by Burrow."
Write-Host "If you sign in with a Microsoft account, use that account's password (not your PIN)."
$cred = Get-Credential -UserName $user -Message "Your Windows password, so Burrow can start at boot"
if (-not $cred) { Write-Host "Cancelled."; return }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$PSScriptRoot\background.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"   # give the network a moment after boot
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

Write-Host ""
Write-Host "Start-at-boot is on. From the next restart, Ollama and Burrow start by themselves, even before you sign in."
Write-Host "Control center: http://127.0.0.1:4747 (or double-click burrow-host.bat)"
Write-Host "Log file: $PSScriptRoot\background.log"
Write-Host "To turn it off: autostart-off.bat"
