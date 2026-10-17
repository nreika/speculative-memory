# Safe restart of the Node server (port 3000), between captures only.
#   1) refuse unless the last line of logs\server.log is "[capture] completed|failed|cancelled"
#   2) refuse if the running server started less than 60 s ago (another session just restarted it)
#   3) start via Invoke-CimMethod Win32_Process Create (survives the calling shell), then stop the old PID
#   4) within 30 s: port 3000 LISTEN + HTTP answer (/api/usage; there is no /api/health); otherwise retry once and show server.err.log
# Prints stop time, recovery time and downtime seconds (put them in the report).
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'logs\server.log'
$last = Get-Content $log -Tail 1
if ($last -notmatch 'capture\] (completed|failed|cancelled)') { "NOT RESTARTING: capture in progress or unknown state. last line: $last"; exit 1 }
$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $p = Get-Process -Id $c.OwningProcess
  if (((Get-Date) - $p.StartTime).TotalSeconds -lt 60) { "NOT RESTARTING: server started $([int]((Get-Date) - $p.StartTime).TotalSeconds) s ago"; exit 1 }
}
$cmd = "cmd.exe /c `"cd /d $repo && node_modules\.bin\tsx.cmd server.ts >> logs\server.log 2>> logs\server.err.log`""
# ShowWindow=0 (SW_HIDE): the server's console window stays hidden (stop it with stop-server.ps1 or taskkill)
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
function Start-Server { (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $repo; ProcessStartupInformation = $si }).ReturnValue }
function Test-Up {
  $l = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if (-not $l) { return $false }
  try { (Invoke-WebRequest 'http://127.0.0.1:3000/api/usage' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}
$stopAt = Get-Date
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
"stopped at $($stopAt.ToString('HH:mm:ss')); start rc=$(Start-Server)"
$up = $false
for ($attempt = 0; $attempt -lt 2 -and -not $up; $attempt++) {
  for ($i = 0; $i -lt 15; $i++) { if (Test-Up) { $up = $true; break }; Start-Sleep 2 }
  if (-not $up) { "not up after 30 s; err log tail:"; Get-Content (Join-Path $repo 'logs\server.err.log') -Tail 8; "retry start rc=$(Start-Server)" }
}
$upAt = Get-Date
if ($up) { "up at $($upAt.ToString('HH:mm:ss')); downtime $([int]($upAt - $stopAt).TotalSeconds) s" } else { "STILL DOWN after retries; downtime so far $([int]($upAt - $stopAt).TotalSeconds) s"; exit 2 }
