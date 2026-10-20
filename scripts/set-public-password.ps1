# Sets PUBLIC_OUTPUT_PASSWORD in .env.local interactively (never echoes the value).
# Run in your own terminal:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-public-password.ps1
# Takes effect after the next server restart (the server reads .env.local at startup).
$ErrorActionPreference = 'Stop'
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.local'
if (-not (Test-Path $envFile)) { Write-Host ".env.local not found: $envFile"; exit 1 }
$p1 = Read-Host -AsSecureString 'New public password (8+ chars, letters/digits/-_.!)'
$p2 = Read-Host -AsSecureString 'Repeat'
$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1); $s1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2); $s2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
if ($s1 -ne $s2) { Write-Host 'Passwords do not match.'; exit 1 }
if ($s1.Length -lt 8 -or $s1 -notmatch '^[A-Za-z0-9._!-]+$') { Write-Host 'Use 8+ characters: letters, digits, . _ ! -'; exit 1 }
$lines = Get-Content $envFile -Encoding UTF8
$found = $false
$out = foreach ($l in $lines) { if ($l -match '^PUBLIC_OUTPUT_PASSWORD=') { $found = $true; "PUBLIC_OUTPUT_PASSWORD=$s1" } else { $l } }
if (-not $found) { $out += "PUBLIC_OUTPUT_PASSWORD=$s1" }
[IO.File]::WriteAllLines($envFile, $out, (New-Object Text.UTF8Encoding $false))
$s1 = $null; $s2 = $null
Write-Host 'ok - PUBLIC_OUTPUT_PASSWORD updated. It applies after the next server restart.'
