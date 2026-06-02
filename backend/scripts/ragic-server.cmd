@echo off
chcp 65001 >nul 2>&1
setlocal enableextensions

REM ============================================================
REM Ragic Report Backend simple control panel
REM   1. Start
REM   2. Full update        (npm ci + build + start)
REM   3. Pull + Full update  (git pull + ci + build + start)
REM   4. Exit
REM ============================================================

REM ====== Edit these if your paths differ ======
set "BACKEND_DIR=C:\path\to\ragic-report\backend"
set "NODE_DIR=C:\tools\node-v20.20.0-win-x64"
REM Leave GIT_DIR empty to auto-detect common install paths
set "GIT_DIR="
REM ============================================

set "NODE_EXE=%NODE_DIR%\node.exe"
set "API_BASE=http://127.0.0.1:3000"

REM --- Auto-detect Git if GIT_DIR is not set ---
if not defined GIT_DIR (
  if exist "C:\Program Files\Git\cmd\git.exe" set "GIT_DIR=C:\Program Files\Git\cmd"
)
if not defined GIT_DIR (
  if exist "C:\Program Files (x86)\Git\cmd\git.exe" set "GIT_DIR=C:\Program Files (x86)\Git\cmd"
)
if not defined GIT_DIR (
  if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT_DIR=%LOCALAPPDATA%\Programs\Git\cmd"
)

if not exist "%NODE_EXE%" (
  echo.
  echo [ERROR] Node.exe not found at: %NODE_EXE%
  echo         Set NODE_DIR env var or edit this bat.
  echo.
  pause
  exit /b 1
)

if not exist "%BACKEND_DIR%\package.json" (
  echo.
  echo [ERROR] Backend package.json not found: %BACKEND_DIR%\package.json
  echo         Run this bat from backend\scripts\.
  echo.
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
if defined GIT_DIR set "PATH=%GIT_DIR%;%PATH%"
cd /d "%BACKEND_DIR%"

:menu
cls
echo ==========================================
echo  Ragic Report Backend
echo ==========================================
echo  Dir : %BACKEND_DIR%
echo  Node:
node -v
echo.
echo  1. Start
echo  2. Full update        (ci + build + start)
echo  3. Pull + Full update  (git pull + ci + build + start)
echo  4. Exit
echo ==========================================
choice /c 1234 /n /m "Select (1/2/3/4): "
if errorlevel 4 goto quit
if errorlevel 3 goto pull_update
if errorlevel 2 goto full_update
if errorlevel 1 goto start_only
goto menu

:quit
endlocal
exit /b 0

:start_only
echo.
echo [Starting]
call npm run start
echo.
echo [Server stopped, returning to menu]
pause
goto menu

:full_update
echo.
echo [1/3] npm ci
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci failed.
  pause
  goto menu
)

echo.
echo [2/3] npm run build
call npm run build
if errorlevel 1 (
  echo [ERROR] npm run build failed.
  pause
  goto menu
)

echo.
choice /c YN /n /m "[3/3] Run 104/105 SQLite sync after start? (Y/N): "
if errorlevel 2 goto start_foreground
if errorlevel 1 goto start_with_sync
goto menu

:pull_update
echo.
if not defined GIT_DIR (
  echo [ERROR] Git not found. Install Git for Windows or set GIT_DIR at top of this bat.
  pause
  goto menu
)
echo [1/4] git pull
git pull
if errorlevel 1 (
  echo [ERROR] git pull failed.
  pause
  goto menu
)

echo.
echo [2/4] npm ci
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci failed.
  pause
  goto menu
)

echo.
echo [3/4] npm run build
call npm run build
if errorlevel 1 (
  echo [ERROR] npm run build failed.
  pause
  goto menu
)

echo.
choice /c YN /n /m "[4/4] Run 104/105 SQLite sync after start? (Y/N): "
if errorlevel 2 goto start_foreground
if errorlevel 1 goto start_with_sync

:start_foreground
echo.
echo [Starting foreground]
call npm run start
echo.
echo [Server stopped, returning to menu]
pause
goto menu

:start_with_sync
echo.
echo [Starting server in new window, will trigger sync after 10s...]
start "RagicReportBackend" cmd /k "cd /d ""%BACKEND_DIR%"" && set ""PATH=%NODE_DIR%;%%PATH%%"" && npm run start"
timeout /t 10 /nobreak >nul

echo.
echo [sync 104]
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri '%API_BASE%/api/forms/104/sync?async=1' | ConvertTo-Json -Depth 10 } catch { $_ | Out-String }"

echo.
echo [sync 105]
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri '%API_BASE%/api/forms/105/sync?async=1' | ConvertTo-Json -Depth 10 } catch { $_ | Out-String }"

echo.
echo [OK] Sync dispatched (async task). Server runs in the other window.
pause
goto menu
