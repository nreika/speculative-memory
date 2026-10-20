# Registers two per-user Task Scheduler tasks (trigger: at log on, run only when logged on, hidden launch).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 [-DryRun|-WhatIf]
# Remove with scripts\uninstall-autostart.ps1. Comfy Desktop :8000 is intentionally NOT auto-started.
[CmdletBinding()]
param([Alias('WhatIf')][switch]$DryRun)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$user = "$env:USERDOMAIN\$env:USERNAME"
$labRoot = 'C:\Users\nmrei\claude-code\qwen21-turbo-lab'
$comfyLaunch = Join-Path $labRoot 'launch-comfy8001.ps1'
$comfyLog = Join-Path $labRoot 'runtime\comfy8001-autostart.log'
$nodeScript = Join-Path $repo 'scripts\start-server-autostart.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$comfyArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$comfyLaunch' *>> '$comfyLog'`""
$nodeArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$nodeScript`""
$defs = @(
  @{ Name = 'SpeculativeMemory ComfyUI 8001'; Args = $comfyArgs; Dir = $labRoot },
  @{ Name = 'SpeculativeMemory Node 3000'; Args = $nodeArgs; Dir = $repo }
)
foreach ($d in $defs) {
  "TASK  : $($d.Name)`n  user   : $user (at log on, run only when logged on, limited run level)`n  action : $ps $($d.Args)`n  cwd    : $($d.Dir)`n  retry  : 3 x every 1 min; no battery/idle conditions; no time limit; single instance"
}
if ($DryRun) { 'DRY RUN: nothing registered.'; return }
if (-not (Test-Path $comfyLaunch)) { throw "missing $comfyLaunch" }
New-Item -ItemType Directory -Path (Split-Path $comfyLog) -Force | Out-Null

foreach ($d in $defs) {
  $action = New-ScheduledTaskAction -Execute $ps -Argument $d.Args -WorkingDirectory $d.Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.IdleSettings.StopOnIdleEnd = $false
  $settings.IdleSettings.RestartOnIdle = $false
  Register-ScheduledTask -TaskName $d.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  "registered: $($d.Name)"
}
foreach ($d in $defs) { schtasks /query /tn $d.Name /fo list }
