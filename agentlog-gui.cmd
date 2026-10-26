@echo off
REM agentlog GUI launcher - double click to start
setlocal
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell not found.
  pause
  exit /b 1
)
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0agentlog-gui.ps1" %*
