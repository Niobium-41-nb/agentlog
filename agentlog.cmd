@echo off
REM agentlog launcher for Windows (double-click friendly)
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 22.5 or newer: https://nodejs.org
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0agentlog.mjs" . --redact
  echo.
  pause
) else (
  node "%~dp0agentlog.mjs" %*
)
