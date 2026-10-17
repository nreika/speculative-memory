# Read-only inventory. Does not install, load models, or run inference.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Continue'

function Find-ToolPath {
    param([string]$Name, [string[]]$Fallbacks)
    $toolCommand = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($toolCommand) { return $toolCommand.Source }
    foreach ($toolPath in $Fallbacks) {
        if (Test-Path -LiteralPath $toolPath -PathType Leaf) { return $toolPath }
    }
    return $null
}

$ollamaExe = Find-ToolPath 'ollama' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")
$tailscaleExe = Find-ToolPath 'tailscale' @("$env:ProgramFiles\Tailscale\tailscale.exe")
$gpuExe = Find-ToolPath 'nvidia-smi' @("$env:windir\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe")

Write-Output '--- GPU / VRAM ---'
if ($gpuExe) { & $gpuExe --query-gpu=name,memory.total --format=csv,noheader }
else {
    Write-Output 'nvidia-smi not found; VRAM still needs checking.'
    Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion
}

Write-Output '--- Ollama installed ---'
if ($ollamaExe) { Write-Output $ollamaExe }
else { Write-Output 'Ollama executable not found in PATH or default location.' }

Write-Output '--- Ollama local API (read-only, 5 second timeout) ---'
try {
    $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
    if (@($tags.models).Count -eq 0) { Write-Output 'No models installed.' }
    else { $tags.models | Select-Object name,@{Name='DiskGiB';Expression={[math]::Round($_.size / 1GB, 2)}} }
    $running = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 5
    Write-Output 'Currently loaded models:'
    $running.models | Select-Object name,size,size_vram
} catch {
    Write-Output 'Local Ollama API unavailable. It may be stopped or bound to another address. No restart attempted.'
}

Write-Output '--- Tailscale IPv4 ---'
if ($tailscaleExe) { & $tailscaleExe ip -4 }
else { Write-Output 'Tailscale executable not found in PATH or default location.' }

Write-Output '--- Ollama user environment ---'
foreach ($settingName in @('OLLAMA_HOST','OLLAMA_CONTEXT_LENGTH','OLLAMA_KEEP_ALIVE')) {
    [pscustomobject]@{Name=$settingName;Value=[Environment]::GetEnvironmentVariable($settingName,'User')}
}

Write-Output '--- Listening on 11434 ---'
Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort
Write-Output 'Done. No generation, installation, or configuration changes performed.'
