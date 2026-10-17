# ポート3000を持っているプロセスを（子プロセスごと）止める
# 使い方: powershell -File scripts\stop-server.ps1 [-WhatIf]
[CmdletBinding(SupportsShouldProcess)]
param()
$port = 3000
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listen) {
    Write-Host "ポート $port で動いているものはありません。"
    exit 0
}
$procId = [int]$listen.OwningProcess
$w = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
Write-Host "ポート $port を持っているプロセス: PID $procId ($($w.Name))"
Write-Host "  コマンド: $($w.CommandLine)"
if ($PSCmdlet.ShouldProcess("PID $procId", "taskkill /T /F")) {
    taskkill /PID $procId /T /F
}
