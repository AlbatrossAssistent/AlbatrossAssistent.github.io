# Start at boot for the Albatross Windows app (desktop/main.js runs this with admin rights when you switch "Start at boot" on
# in the control center). Creates the same scheduled task as autostart.ps1, "Burrow host", but it starts the host with the
# Node.js inside the app (through start-host.cmd, which the app keeps up to date), at boot, before anyone signs in.
# Windows asks for your account password in its own dialog and keeps it for the task; Albatross never sees it.
param([ValidateSet("install", "uninstall")][string]$Action = "install", [string]$Cmd = "", [string]$WorkDir = "")
$ErrorActionPreference = "Stop"
$TaskName = "Burrow host"
try {
  if ($Action -eq "uninstall") {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    exit 0
  }
  if (-not (Test-Path $Cmd)) { throw "The start file is missing: $Cmd" }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $cred = Get-Credential -UserName $user -Message "Albatross: your Windows password, so Albatross can start when the PC boots (before you sign in). With a Microsoft account use its password, not the PIN."
  if (-not $cred) { exit 2 }
  $taskAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Cmd`"" -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = "PT30S"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
  exit 0
} catch {
  Set-Content -Path (Join-Path $env:TEMP "albatross-autostart-error.txt") -Value $_.Exception.Message
  exit 1
}
