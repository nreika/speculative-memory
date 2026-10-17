<#
 Laptop Ollama check (run on THIS PC).  One tiny vision request, no ComfyUI/Gemini involved.
 Usage:  powershell -ExecutionPolicy Bypass -File scripts\check-ollama.ps1 -Url http://192.168.x.x:11434 [-Model qwen3-vl:8b]
 The request has the same shape as server/generation/vlmClient.ts (POST /api/generate,
 bare base64 in "images", stream:false, format:"json", keep_alive, options).
#>
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Model = 'qwen3-vl:8b',
  [string]$Image = 'C:\Users\nmrei\GitHub\speculative-memory_data\test_set\10_dark_empty_room.jpg',
  [string]$Scratch = 'C:\Users\nmrei\AppData\Local\Temp\claude\C--Users-nmrei-claude-code\c83c9d29-004f-49f0-ad95-bd193c4f2adc\scratchpad',
  [int]$TimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')

Write-Host "== 1. Reachability: $Url/api/tags"
try {
  $tags = Invoke-RestMethod -Uri "$Url/api/tags" -TimeoutSec 5
} catch {
  Write-Host "NOT REACHABLE: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check: Ollama running on the laptop, OLLAMA_HOST=0.0.0.0 set + Ollama restarted, firewall TCP 11434, same network, correct IP."
  exit 1
}
Write-Host "OK"

Write-Host "== 2. Models on the laptop"
foreach ($m in $tags.models) { '{0,-30} {1,6:N1} GB' -f $m.name, ($m.size / 1GB) }
$names = @($tags.models | ForEach-Object { $_.name })
$has = ($names -contains $Model) -or ($names -contains "$Model`:latest")
if (-not $has) {
  Write-Host "Model '$Model' is NOT installed. On the laptop run: ollama pull $Model" -ForegroundColor Red
  exit 1
}
Write-Host "Model '$Model' is present." -ForegroundColor Green

Write-Host "== 3. Downscale test image to ~512 px (PIL)"
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
$small = Join-Path $Scratch 'check_ollama_512.jpg'
$env:PYTHONUTF8 = '1'
$py = "from PIL import Image; im=Image.open(r'$Image').convert('RGB'); im.thumbnail((512,512)); im.save(r'$small', quality=85); print(im.size)"
python -c $py
if ($LASTEXITCODE -ne 0) { Write-Host "Python/PIL failed" -ForegroundColor Red; exit 1 }
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($small))

Write-Host "== 4. One vision request (first call may take long: model loading)"
$prompt = 'Look at this camera frame. Return ONLY a JSON object {"scene_description":"..."} where scene_description is a plain Japanese description (1-2 short sentences) of what is visible. No markdown.'
$body = @{
  model      = $Model
  prompt     = $prompt
  images     = @($b64)
  stream     = $false
  think      = $false
  format     = 'json'
  keep_alive = '5m'
  options    = @{ temperature = 0.9; num_predict = 300 }
} | ConvertTo-Json -Depth 5 -Compress
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $res = Invoke-RestMethod -Uri "$Url/api/generate" -Method Post -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec $TimeoutSec
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$sw.Stop()
if ($res.error) { Write-Host "Ollama error: $($res.error)" -ForegroundColor Red; exit 1 }
Write-Host "Reply: $($res.response)"
Write-Host ("Elapsed: {0:N1} s   (Ollama total {1:N1} s, load {2:N1} s, prompt {3} tok, output {4} tok)" -f `
  $sw.Elapsed.TotalSeconds, ($res.total_duration / 1e9), ($res.load_duration / 1e9), $res.prompt_eval_count, $res.eval_count)
Write-Host "Run it twice: the 2nd call (model already loaded) is the realistic per-capture time."

Write-Host ""
Write-Host "== Switch this PC to the laptop: put these in .env.local" -ForegroundColor Cyan
Write-Host "GENERATION_BACKEND=local"
Write-Host "OLLAMA_URL=$Url"
Write-Host "VLM_MODEL=$Model"
Write-Host "OLLAMA_KEEP_ALIVE=5m"
Write-Host "QA_ENABLED=false"
Write-Host ""
Write-Host "Then RESTART the Node server (env is read at start; ask first, start it from your own terminal)."
Write-Host "In local mode: scenario planning no longer calls Gemini, BUT the Gemini QA judge (server/qa/imageJudge.ts)"
Write-Host "still runs after every capture if QA_ENABLED is not false and a Gemini key exists, and is still billed/recorded"
Write-Host "in logs/usage.jsonl. Set QA_ENABLED=false (above) for a fully Gemini-free run. Cost display only shows QA calls."
