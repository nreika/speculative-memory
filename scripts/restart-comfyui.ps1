# Restart ComfyUI (port 8000) after a hang: a job stuck inside a kernel keeps the queue blocked and neither
# POST /interrupt nor POST /queue {"clear":true} removes it (2026-10-17: 7 h of failed captures).
#   1) stop the python.exe that LISTENs on :8000 and its parent python.exe (the Comfy Desktop .venv launcher)
#   2) start ComfyUI detached (Invoke-CimMethod Win32_Process Create; survives this shell), log appended to
#      Documents\ComfyUI\comfyui-manual-restart.log
#   3) wait up to 75 s for GET /queue; exit 0 = answering, 2 = still down
# The Node server calls this itself (server/generation/comfyWatchdog.ts) and never while a capture is running.
param([int]$Port = 8000, [int]$WaitSec = 75, [switch]$DryRun)
$py = 'C:\Users\nmrei\Documents\ComfyUI\.venv\Scripts\python.exe'
$cwd = 'C:\Users\nmrei\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI'
$base = 'C:\Users\nmrei\Documents\ComfyUI'
$log = Join-Path $base 'comfyui-manual-restart.log'

$conn = if ($DryRun) { $null } else { Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }
$stopAt = Get-Date
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  $parent = if ($proc) { Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" } else { $null }
  if ($proc -and $proc.Name -eq 'python.exe') { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue; "stopped python $($proc.ProcessId)" }
  if ($parent -and $parent.Name -eq 'python.exe') { Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue; "stopped parent python $($parent.ProcessId)" }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
} else { "nothing listening on :$Port" }

$args = @(
  '-s', 'ComfyUI\main.py', '--feature-flag', 'show_signin_button=true',
  '--base-directory', $base, '--user-directory', "$base\user",
  '--database-url', "sqlite:///$base\user\comfyui.db", '--port', "$Port", '--enable-manager',
  '--extra-model-paths-config', '"C:\Users\nmrei\AppData\Roaming\Comfy Desktop\instance-model-paths\inst-1787892066438.yaml"',
  '--input-directory', "$base\input", '--output-directory', "$base\output"
) -join ' '
$cmd = "cmd.exe /c `"cd /d $cwd && `"$py`" $args >> `"$log`" 2>&1`""
if ($DryRun) { "DRY RUN: $cmd"; exit 0 }
# ShowWindow=0 (SW_HIDE): no console window is left open on the desktop
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$rc = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $cwd; ProcessStartupInformation = $si }).ReturnValue
"started rc=$rc"

for ($i = 0; $i -lt $WaitSec; $i++) {
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/queue" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
      "ComfyUI answering after $([int]((Get-Date) - $stopAt).TotalSeconds) s"; exit 0
    }
  } catch {}
  Start-Sleep 1
}
"ComfyUI still not answering after $WaitSec s (see $log)"; exit 2
