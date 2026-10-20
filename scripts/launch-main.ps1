# Desktop icon "Speculative Memory" (main PC). Starts whatever is not running yet, then opens MAIN.
#   1) turbo ComfyUI :8001  (C:\Users\nmrei\claude-code\qwen21-turbo-lab\launch-comfy8001.ps1, hidden)
#   2) Node server  :3000   (scripts\start-server-autostart.ps1, hidden; it waits for :8001 itself)
#   3) waits until http://127.0.0.1:3000/control/ answers (max 4 min), then opens it in the default browser.
# Safe to click again: running services are left alone. Log: logs\launcher.log
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'logs\launcher.log'
New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$labRoot = 'C:\Users\nmrei\claude-code\qwen21-turbo-lab'
$comfyLaunch = Join-Path $labRoot 'launch-comfy8001.ps1'
$comfyLog = Join-Path $labRoot 'runtime\comfy8001-autostart.log'
if (-not (Listening 8001)) {
  if (Test-Path $comfyLaunch) {
    Log 'starting ComfyUI 8001'
    Start-Process -FilePath $ps -WindowStyle Hidden -WorkingDirectory $labRoot -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-Command',"& '$comfyLaunch' *>> '$comfyLog'")
  } else { Log "missing $comfyLaunch" }
} else { Log 'ComfyUI 8001 already running' }

if (-not (Listening 3000)) {
  Log 'starting Node 3000'
  Start-Process -FilePath $ps -WindowStyle Hidden -WorkingDirectory $repo -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $repo 'scripts\start-server-autostart.ps1'))
} else { Log 'Node 3000 already running' }

$deadline = (Get-Date).AddMinutes(4); $up = $false
while ((Get-Date) -lt $deadline) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:3000/control/' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $up = $true; break } } catch {}
  Start-Sleep 2
}
Log "MAIN reachable=$up"
Start-Process 'http://127.0.0.1:3000/control/'
