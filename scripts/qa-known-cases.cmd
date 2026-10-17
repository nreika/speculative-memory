@echo off
rem Runs the local QA on the known-bad archived generations (output: logs\qa-known-cases.out.log). Waits for idle windows.
cd /d %~dp0..
for %%G in (2026-10-16_12-42-43:B 2026-10-16_12-56-48:B 2026-10-16_14-21-09:A 2026-10-16_14-24-41:B 2026-10-16_14-29-22:C 2026-10-16_14-11-46:B 2026-10-16_19-57-26:A 2026-10-17_12-49-13:B) do (
  for /f "tokens=1,2 delims=:" %%a in ("%%G") do call node_modules\.bin\tsx.cmd scripts\qa-judge.ts %%a %%b
)
