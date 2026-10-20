# Shows the public output password (and the remote-camera link token) from .env.local.
# Run it yourself in your own terminal only; do not paste the output into chats or logs.
$file = Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local'
if (-not (Test-Path $file)) { 'No .env.local. Run: npx tsx scripts/ensure-public-secrets.ts'; exit 1 }
$lines = Get-Content $file
$pw = ($lines | Where-Object { $_ -match '^\s*PUBLIC_OUTPUT_PASSWORD\s*=' } | Select-Object -Last 1) -replace '^\s*PUBLIC_OUTPUT_PASSWORD\s*=\s*', ''
$tk = ($lines | Where-Object { $_ -match '^\s*PUBLIC_CAPTURE_TOKEN\s*=' } | Select-Object -Last 1) -replace '^\s*PUBLIC_CAPTURE_TOKEN\s*=\s*', ''
if (-not $pw) { 'PUBLIC_OUTPUT_PASSWORD is not set. Run: npx tsx scripts/ensure-public-secrets.ts'; exit 1 }
"Public output password: $pw"
"Login: http://127.0.0.1:3443/login  (after Funnel: https://emergent-2.taila81ee8.ts.net/login)"
if ($tk) { "Remote camera link (phone): https://emergent-2.taila81ee8.ts.net/capture/?token=$tk" }
