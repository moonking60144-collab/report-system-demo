@echo off
setlocal enableextensions

REM =============================================================================
REM Ragic Report Backend Launcher (Windows Server)
REM - Always uses portable Node 20 first (coexist mode)
REM - Default: production start
REM - Optional arg: dev
REM =============================================================================

set "NODE20_HOME=C:\tools\node-v20.20.0-win-x64"
set "NODE20_EXE=%NODE20_HOME%\node.exe"

if not exist "%NODE20_EXE%" (
  echo [ERROR] Node 20 not found: %NODE20_EXE%
  echo [HINT] Please unzip node-v20.x-win-x64 to C:\tools first.
  exit /b 1
)

set "PATH=%NODE20_HOME%;%PATH%"

for %%I in ("%~dp0..") do set "BACKEND_DIR=%%~fI"
cd /d "%BACKEND_DIR%"
if errorlevel 1 (
  echo [ERROR] Cannot switch to backend directory: %BACKEND_DIR%
  exit /b 1
)

for /f "usebackq delims=" %%V in (`node -v`) do set "NODE_VERSION=%%V"
echo [INFO] Backend dir: %BACKEND_DIR%
echo [INFO] Using Node: %NODE_VERSION%

if not exist "node_modules" (
  echo [INFO] node_modules not found, running npm ci...
  call npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    exit /b 1
  )
)

if /i "%~1"=="dev" (
  echo [INFO] Starting backend in DEV mode...
  call npm run dev
  exit /b %errorlevel%
)

if not exist "dist\server.js" (
  echo [INFO] dist\server.js not found, running npm run build...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] npm run build failed.
    exit /b 1
  )
)

echo [INFO] Starting backend in PROD mode...
call npm run start
exit /b %errorlevel%

