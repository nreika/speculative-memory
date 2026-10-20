@echo off
rem Runs the local QA on the known-bad archived generations (output: logs\qa-known-cases.out.log). Waits for idle windows.
cd /d %~dp0..
rem extra_hand (third hand; 2026-10-19): 2026-10-19_03-41-22:B (capture ...1792348882852), 2026-10-19_14-04-33:B (F009, Gen_b_14-05-26), 2026-10-19_14-05-47:B (F010, Gen_b_14-06-42)
for %%G in (2026-10-16_12-42-43:B 2026-10-16_12-56-48:B 2026-10-16_14-21-09:A 2026-10-16_14-24-41:B 2026-10-16_14-29-22:C 2026-10-16_14-11-46:B 2026-10-16_19-57-26:A 2026-10-17_12-49-13:B 2026-10-17_13-25-20:A 2026-10-19_03-41-22:B 2026-10-19_14-04-33:B 2026-10-19_14-05-47:B) do (
  for /f "tokens=1,2 delims=:" %%a in ("%%G") do call node_modules\.bin\tsx.cmd scripts\qa-judge.ts %%a %%b
)
