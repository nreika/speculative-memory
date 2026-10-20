# Prints the phone capture URL (with the capture token) for the public gate. Run in your own terminal only.
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.local'
$token = (Select-String -Path $envFile -Pattern '^PUBLIC_CAPTURE_TOKEN=(.+)$').Matches[0].Groups[1].Value
if (-not $token) { Write-Host 'PUBLIC_CAPTURE_TOKEN is not set in .env.local'; exit 1 }
$host_ = 'emergent-2.taila81ee8.ts.net'
Write-Host "Phone capture URL (open once; a cookie keeps you signed in for 12 h):"
Write-Host "https://$host_/capture/?token=$token"
Write-Host "Status check:  https://$host_/capture/status"
