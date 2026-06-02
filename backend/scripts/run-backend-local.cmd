@echo off
setlocal enableextensions

REM =============================================================================
REM Ragic Report Backend Local Test Launcher (Windows)
REM - Uses portable Node 20 first, fallback to installed/system Node
REM - Overrides PORT / CORS_ORIGIN only for this process
REM - Default: dev mode on http://localhost:3300
REM - CORS allows both http://localhost:5174 and http://127.0.0.1:5174
REM =============================================================================

set "PORTABLE_NODE20_HOME=C:\tools\node-v20.20.0-win-x64"
set "LOCAL_NODE20_HOME=C:\Program Files\nodejs"
set "NODE20_HOME="
set "NODE_EXE=node"

if exist "%PORTABLE_NODE20_HOME%\node.exe" (
  set "NODE20_HOME=%PORTABLE_NODE20_HOME%"
)

if not defined NODE20_HOME if exist "%LOCAL_NODE20_HOME%\node.exe" (
  set "NODE20_HOME=%LOCAL_NODE20_HOME%"
)

if defined NODE20_HOME (
  set "PATH=%NODE20_HOME%;%PATH%"
  set "NODE_EXE=%NODE20_HOME%\node.exe"
)

if defined NODE20_HOME (
  if not exist "%NODE_EXE%" (
    echo [ERROR] node.exe not found: %NODE_EXE%
    echo [HINT] Install Node.js or unzip portable Node 20 to C:\tools\node-v20.20.0-win-x64
    exit /b 1
  )
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] node.exe not found in PATH.
    echo [HINT] Install Node.js or unzip portable Node 20 to C:\tools\node-v20.20.0-win-x64
    exit /b 1
  )
)

for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -v`) do set "NODE_VERSION=%%V"
echo [INFO] Using Node: %NODE_VERSION%
echo %NODE_VERSION% | findstr /r "^v20\." >nul
if errorlevel 1 (
  echo [WARN] Project baseline is Node 20.x. Current version: %NODE_VERSION%
  echo [WARN] Local dev will continue with the detected Node version.
)

for %%I in ("%~dp0..") do set "BACKEND_DIR=%%~fI"
cd /d "%BACKEND_DIR%"
if errorlevel 1 (
  echo [ERROR] Cannot switch to backend directory: %BACKEND_DIR%
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

set "PORT=3300"
set "CORS_ORIGIN=http://localhost:5174,http://127.0.0.1:5174"
set "PORT_PID="

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "PORT_PID=%%P"
  goto :port_check_done
)

:port_check_done
if defined PORT_PID (
  echo [ERROR] Port %PORT% is already in use by PID %PORT_PID%.
  echo [HINT] Close the existing backend window or run: taskkill /PID %PORT_PID% /F
  exit /b 1
)

echo [INFO] Backend dir: %BACKEND_DIR%
echo [INFO] Local test PORT=%PORT%
echo [INFO] Local test CORS_ORIGIN=%CORS_ORIGIN%
echo [INFO] Starting backend in DEV mode...

call npm run dev
exit /b %errorlevel%
