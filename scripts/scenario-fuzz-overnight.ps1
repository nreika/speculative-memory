# Unattended scenario fuzzing on the main PC (no Claude, no LLM, no GPU) with a built-in watchdog.
# Runs scripts\scenario-fuzz.py in 4-minute batches (15 short scenarios) with a new seed each time until -Until (local time).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-fuzz-overnight.ps1 -Until 07:00
# Watchdog (2026-10-21: the first night ran 4 hours against a server that refused every command):
#   - before each batch: a harmless operator command must succeed, else HALT
#   - after each batch: if one violation message accounts for >= 60% of the runs, HALT (the server is stuck, not fuzzed)
#   On HALT or at the end: Auto generation is resumed, and the reason is written to logs\scenario-fuzz\STATUS.txt.
param([string]$Until = '07:00')
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$dir = Join-Path $repo 'logs\scenario-fuzz'; New-Item -ItemType Directory -Path $dir -Force | Out-Null
$log = Join-Path $dir 'overnight.log'; $status = Join-Path $dir 'STATUS.txt'
function Log($m) { Add-Content $log ("{0} {1}" -f (Get-Date -Format s), $m) }
function Status($m) { Set-Content $status ("{0} {1}" -f (Get-Date -Format s), $m) -Encoding utf8; Log $m }
$H = @{ 'X-Control-Request' = '1'; 'Origin' = 'http://127.0.0.1:3000' }
function Act($name) {
  $body = @{ action = $name; data = @{}; requestId = [guid]::NewGuid().ToString('N') } | ConvertTo-Json -Compress
  try { Invoke-RestMethod 'http://127.0.0.1:3000/api/td-control/action' -Method Post -Headers $H -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null; return $true } catch { return $false }
}
$end = [datetime]::Today.Add([timespan]::Parse($Until)); if ($end -lt (Get-Date)) { $end = $end.AddDays(1) }
$seed = [int](Get-Date -UFormat %s) % 100000
Status "RUNNING until $($end.ToString('s'))"
$halt = $null
while ((Get-Date) -lt $end) {
  if (-not (Act 'generation.pause')) { $halt = 'server refused a plain generation.pause before a batch'; break }
  $seed++
  $out = & python scripts\scenario-fuzz.py --seed $seed --runs 15 --budget-min 4 2>&1 | Select-Object -Last 3
  Log ("seed {0}: {1}" -f $seed, ($out -join ' | '))
  $latest = Get-ChildItem $dir -Filter '*.jsonl' | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($latest) {
    $runs = 0; $msgs = @{}
    foreach ($line in Get-Content $latest.FullName) {
      try { $r = $line | ConvertFrom-Json } catch { continue }
      if ($r.kind -eq 'run_start') { $runs++ }
      if ($r.kind -eq 'violation') { $k = ($r.msg -replace '\d+', 'N'); if ($k.Length -gt 120) { $k = $k.Substring(0, 120) }; $msgs[$k] = 1 + [int]$msgs[$k] }
    }
    $top = $msgs.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
    if ($top -and $runs -gt 0 -and $top.Value -ge [math]::Max(5, 0.6 * $runs)) { $halt = "one violation repeated $($top.Value)/$runs runs in $($latest.Name): $($top.Key)"; break }
  }
  Start-Sleep -Seconds 5
}
$resumed = Act 'generation.resume'
if ($halt) { Status "HALTED: $halt (Auto resumed=$resumed)" } else { Status "DONE at $(Get-Date -Format s) (Auto resumed=$resumed)" }
