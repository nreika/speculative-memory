# 状況認識用ノートの準備（Windows / Tailscale）

更新: 2026-10-12。Tailscale と Ollama は導入済み（ユーザー確認）。まず既存環境を確認する。
全体構成は `MULTI-PC-ARCHITECTURE.md`、別端末への引き継ぎ文は `LAPTOP-HANDOFF.md`。

## 1. 現状確認

PowerShellにまとめて貼り付ける。

```powershell
ollama list
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
tailscale ip -4
```

代替: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\inspect-laptop.ps1`。
導入済みモデルがあれば先にそれを確認する。TDとGPUを共有する場合、VRAM 8GBのノートではまず `qwen3-vl:4b` を候補にする。8bが快適に動くとは断定せず、GPUの実測で選ぶ。

## 2. モデルの準備

4bが未導入ならノートで取得する（ダウンロード。推論はまだ行わない）。

```powershell
ollama pull qwen3-vl:4b
```

取得にはインターネット接続とディスク容量が必要。[公式モデルページ](https://ollama.com/library/qwen3-vl:4b)を参照。TDとの併用に余裕があり、品質比較をするときに8bを検討する。モデル本体はGitHubへ入れない。

## 3. ノートの接続設定

以下はノートで設定する。既存値があれば控えてから変更する。Ollamaが他の作業で使われている場合は、その作業終了後に再起動する。

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_CONTEXT_LENGTH', '8192', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '5m', 'User')
```

通知領域でOllamaを終了し、スタートメニューから起動し直す。環境変数変更だけでは既存プロセスに反映されない。[Ollama公式設定手順](https://docs.ollama.com/faq)

次に管理者PowerShellで、メインPCのTailscale IPv4だけからTCP 11434を受けられる規則を作る。`<...>` は実値へ置換する。IPが分からなければここで保留する。

```powershell
$basePcIp = '<メインPCのTailscale IPv4>'
$ruleName = 'SpecMem-Ollama-Tailscale'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Write-Host '既存規則があります。詳細を確認してから更新してください。'
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'SpecMem Ollama from base PC' -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress $basePcIp -Action Allow -Profile Any
}
```

既存の広い許可規則がある場合、この規則を足しても既存規則は狭まらない。必要な接続元を確認して整理する。ルーターでインターネット向けのポート転送は設定しない。

TailscaleはメインPC・ノートを同じtailnetに接続する。[Windows公式手順](https://tailscale.com/docs/install/windows)

## 4. 推論をせず疎通確認

ノートで:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
Get-NetTCPConnection -LocalPort 11434 -State Listen
```

メインPCで:

```powershell
$visionLaptopIp = '<ノートのTailscale IPv4>'
Test-NetConnection -ComputerName $visionLaptopIp -Port 11434
Invoke-RestMethod -Uri "http://${visionLaptopIp}:11434/api/tags" -TimeoutSec 5
```

モデル名が返れば接続確認は完了。TailscaleのIPが分かっただけではOllamaの疎通成功としない。

## 5. 次の担当へ返す情報

- ノートのGPU名・VRAM。
- `ollama list` のモデル名。
- ノートのTailscale IPv4。
- メインPCから `/api/tags` を取得できたか。
- TDと同居させるか、TDはまだ別PCか。

## 6. 生成テストは承認後

`scripts/check-ollama.ps1` は接続確認だけでなく画像推論を1回実行する。無断実行しない。
メインPCで実行するスクリプトで、既定の画像と作業パスはこのPC固有。実行時は `-Image` と `-Scratch` に実在する画像パス・作業用パスを指定する。モデルは `-Model qwen3-vl:4b` 等で明示する。

推論時は画像への回答・秒数と、ノートの `ollama ps` に出るGPU利用状況を確認する。TD同居時は表示の滑らかさも確認する。単純な画像説明が成功しても、三つのシナリオを返す本番経路の成功とは区別する。

メインPC側の `vlmClient.ts` は `num_ctx` 未指定、`num_predict=1024`。JSON切れ・シナリオ不足は後続の調整対象。`GENERATION_BACKEND=local` でもQAはGeminiを使うため、完全なローカル検証時はメインPCで `QA_ENABLED=false` にする。

タイマー撮影は停止を維持。Nodeサーバー設定変更・起動・生成テストはメインPCの担当と合わせて行う。
