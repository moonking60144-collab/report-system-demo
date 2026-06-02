@echo off
setlocal enableextensions

REM =============================================================================
REM Ragic Report Frontend Local Test Launcher (Windows)
REM - Uses local Node.js (Node 20+ recommended)
REM - Overrides VITE_API_BASE_URL only for this process
REM - Default: http://0.0.0.0:5174 -> http://127.0.0.1:3300/api
REM - NOTE: 會對整個內網開放，僅限測試時使用，測完請關閉
REM =============================================================================

set "NODE20_HOME=C:\Program Files\nodejs"
set "NODE20_EXE=%NODE20_HOME%\node.exe"

if not exist "%NODE20_EXE%" (
  echo [ERROR] Node 20 not found: %NODE20_EXE%
  echo [HINT] Please install Node.js 20+ or update NODE20_HOME in this script.
  exit /b 1
)

set "PATH=%NODE20_HOME%;%PATH%"

for %%I in ("%~dp0..") do set "FRONTEND_DIR=%%~fI"
cd /d "%FRONTEND_DIR%"
if errorlevel 1 (
  echo [ERROR] Cannot switch to frontend directory: %FRONTEND_DIR%
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules not found, running npm ci...
  call npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    exit /b 1
  )
)

set "VITE_API_BASE_URL=http://127.0.0.1:3300/api"
set "FRONTEND_PORT=5174"

echo [INFO] Frontend dir: %FRONTEND_DIR%
echo [INFO] Local test VITE_API_BASE_URL=%VITE_API_BASE_URL%
echo [INFO] Local test frontend port=%FRONTEND_PORT%
echo [INFO] Starting frontend in DEV mode...

call npm run dev -- --host 0.0.0.0 --port %FRONTEND_PORT%
exit /b %errorlevel%
