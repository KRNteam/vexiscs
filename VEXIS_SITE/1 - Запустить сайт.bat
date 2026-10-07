@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node "%~dp0VEXIS_APP\launch.js" site
if errorlevel 1 pause
