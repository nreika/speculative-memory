# Removes the two autostart tasks (idempotent). Does not stop running servers.
foreach ($n in 'SpeculativeMemory ComfyUI 8001', 'SpeculativeMemory Node 3000') {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $n -Confirm:$false; "removed: $n" } else { "not registered: $n" }
}
