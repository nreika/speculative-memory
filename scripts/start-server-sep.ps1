# 9月版 のNodeサーバーを起動する（HANDOVER 2章の方法: 独立プロセス、ログは logs/ に出力）
# 使い方: powershell -File scripts$1 [-WhatIf]
#   -WhatIf を付けると、ポート確認だけして実際には起動しない（動作確認用）
[CmdletBinding(SupportsShouldProcess)]
param()

$repo  = 'C:\Users\nmrei\GitHub\speculative-memory_demo-sep'
$label = '9月版'
$port  = 3000

# --- ポート3000を誰が使っているか調べる ---
# 使用中なら、親プロセスをたどってコマンドラインから「どちらのバージョンか」を推定する
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listen) {
    $procId = [int]$listen.OwningProcess
    $version = '不明'
    $cur = $procId
    for ($i = 0; $i -lt 6 -and $cur; $i++) {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $w) { break }
        if ($w.CommandLine -like '*speculative-memory_demo-sep*') { $version = '9月版 (speculative-memory_demo-sep)'; break }
        if ($w.CommandLine -like '*speculative-memory_0905*')     { $version = '現行版 (speculative-memory_0905)'; break }
        $cur = [int]$w.ParentProcessId
    }
    Write-Host "ポート $port は使用中です。起動を中止します。" -ForegroundColor Red
    Write-Host "  持ち主: PID $procId / バージョン: $version"
    Write-Host "  止めるには: powershell -File scripts\stop-server.ps1"
    exit 1
}

if (-not (Test-Path "$repo\node_modules\.bin\tsx.cmd")) {
    Write-Host "tsx が見つかりません: $repo\node_modules（npm ci を実行してください）" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force "$repo\logs" | Out-Null

if ($PSCmdlet.ShouldProcess("$label ($repo)", "サーバー起動 (port $port)")) {
    Start-Process "$repo\node_modules\.bin\tsx.cmd" -ArgumentList 'server.ts' -WorkingDirectory $repo `
        -RedirectStandardOutput "$repo\logs\server.log" -RedirectStandardError "$repo\logs\server.err.log" -WindowStyle Hidden
    Write-Host "$label を起動しました。ログ: $repo\logs\server.log"
    Write-Host "確認: logs\server.log に 'Server running' が出れば起動完了です。"
}
