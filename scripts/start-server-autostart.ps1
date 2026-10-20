# Autostart helper (Task Scheduler "SpeculativeMemory Node 3000", at log on).
# Waits until the turbo ComfyUI (:8001) answers /queue (max 180 s, continues anyway), then starts the Node server
# exactly like safe-restart.ps1's Start-Server (hidden window, same command/cwd) unless :3000 is already listening.
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$trace = Join-Path $logDir 'autostart.log'
function Log($m) { Add-Content -Path $trace -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Log 'port 3000 already listening; nothing to do'; exit 0 }

$deadline = (Get-Date).AddSeconds(180); $comfyUp = $false
while ((Get-Date) -lt $deadline) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:8001/queue' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $comfyUp = $true; break } } catch {}
  Start-Sleep 3
}
Log "comfy8001 up=$comfyUp; starting node"

if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Log 'port 3000 became busy while waiting; skip'; exit 0 }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$bootstrap = Join-Path $repo 'scripts\server-bootstrap.mjs'
$cmd = '"' + $nodePath + '" --import tsx "' + $bootstrap + '"'
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$rc = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $repo; ProcessStartupInformation = $si }).ReturnValue
Log "node start rc=$rc"
if ($rc -ne 0) { exit 1 }
