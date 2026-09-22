@echo off
setlocal enableextensions

REM Demo-only Windows launcher. It never enables a production write target or
REM assumes a server deployment directory.

for %%I in ("%~dp0..") do set "BACKEND_DIR=%%~fI"
cd /d "%BACKEND_DIR%"
if errorlevel 1 (
  echo [ERROR] Cannot switch to backend directory: %BACKEND_DIR%
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing Demo dependencies...
  call npm ci
  if errorlevel 1 exit /b 1
)

set "DEMO_MODE=true"
set "NODE_ENV=development"
set "RAGIC_WRITE_TARGET=test"
set "SERVE_FRONTEND_FROM_BACKEND=false"

echo [INFO] Starting synthetic Demo backend...
call npm run demo
exit /b %errorlevel%
