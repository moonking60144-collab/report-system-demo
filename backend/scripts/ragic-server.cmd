@echo off
title Report
REM ============================================================
REM Ragic Report Backend control panel
REM   1. Start only
REM   2. Build + Start (no git pull)
REM   3. Pull + Build + Start
REM   4. Exit
REM ============================================================

set "BACKEND_DIR=C:\Users\user\Desktop\ragic-report\backend"
set "FRONTEND_DIR=C:\Users\user\Desktop\ragic-report\frontend"
set "FRONTEND_DEPLOY=D:\sites\report"
set "NODE_DIR=C:\node20"
set "UV_THREADPOOL_SIZE=16"
set "NODE_ENV=production"
set "RAGIC_WRITE_TARGET=prod"
set "SERVE_FRONTEND_FROM_BACKEND=true"
set "FRONTEND_STATIC_DIR=%FRONTEND_DEPLOY%"
REM TRUST_PROXY is loaded from backend\.env; do not shadow dotenv here.
set "REPO_DIR=%BACKEND_DIR%\.."
set "BUILD_SCOPE_CMD=%TEMP%\ragic-report-build-scope.cmd"
set "RUN_BACKEND_INSTALL=1"
set "RUN_BACKEND_BUILD=1"
set "RUN_FRONTEND_INSTALL=1"
set "RUN_FRONTEND_BUILD=1"
set "RUN_FRONTEND_SYNC=1"

set "PATH=%NODE_DIR%;%PATH%"
cd /d "%BACKEND_DIR%"

echo ============================================================
echo  Ragic Report Backend
echo ============================================================
echo  Backend  : %BACKEND_DIR%
echo  Frontend : %FRONTEND_DIR%
echo  Dist to  : %FRONTEND_DEPLOY%
echo  Node     :
node -v
echo  Threadpool : UV_THREADPOOL_SIZE=%UV_THREADPOOL_SIZE%
echo  Profile    : NODE_ENV=%NODE_ENV% RAGIC_WRITE_TARGET=%RAGIC_WRITE_TARGET%
echo  Frontend   : SERVE_FRONTEND_FROM_BACKEND=%SERVE_FRONTEND_FROM_BACKEND% FRONTEND_STATIC_DIR=%FRONTEND_STATIC_DIR%
echo ============================================================
echo.
echo  1. Start only
echo  2. Build + Start (no git pull)
echo  3. Pull + Build + Start
echo  4. Exit
choice /c 1234 /n /m "Select: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto pullupdate
if errorlevel 2 goto update
if errorlevel 1 goto start

:pullupdate
echo.
echo [pre] discard package-lock churn left by previous npm install
for %%P in (frontend/package-lock.json backend/package-lock.json) do (
  git -C "%REPO_DIR%" ls-files --error-unmatch %%P >nul 2>nul
  if not errorlevel 1 git -C "%REPO_DIR%" checkout -- %%P
)

for /f "delims=" %%H in ('git -C "%REPO_DIR%" rev-parse HEAD') do set "BEFORE_SYNC=%%H"

echo [1/6] smart git update (safe fast-forward preferred)
call powershell -NoProfile -Command ^
"$branch = (git rev-parse --abbrev-ref HEAD).Trim(); ^
if ($branch -eq 'HEAD') { Write-Host '[ERROR] detached HEAD, cannot run safe pull. Please checkout a branch first.'; exit 2 }; ^
$remote = 'origin/' + $branch; ^
git fetch --prune; ^
git show-ref --verify --quiet ('refs/remotes/' + $remote); ^
if ($LASTEXITCODE -ne 0) { Write-Host ('[ERROR] remote branch not found: ' + $remote); exit 2 }; ^
$ahead = [int](git rev-list --count (($remote + '..HEAD'))); ^
$behind = [int](git rev-list --count (('HEAD..' + $remote))); ^
if ($ahead -eq 0 -and $behind -eq 0) { ^
  Write-Host ('[INFO] ' + $branch + ' up to date with ' + $remote); ^
  exit 0; ^
}; ^
if ($ahead -gt 0 -and $behind -gt 0) { ^
  Write-Host ('[ERROR] branch diverged: ahead=' + $ahead + ', behind=' + $behind); ^
  Write-Host '[ACTION] If this is a definitions baseline commit, open /dev/definitions and click sync then push main, then run option 3 again.'; ^
  Write-Host '[ACTION] If this is not a baseline commit, inspect manually before merge/rebase/reset.'; ^
  exit 2; ^
}; ^
if ($ahead -gt 0) { ^
  Write-Host ('[WARN] local is ahead of ' + $remote + ', skip pull to keep local commits: +' + $ahead); ^
  exit 0; ^
}; ^
if ($behind -gt 0) { git merge --ff-only $remote; exit $LASTEXITCODE }; ^
Write-Host '[ERROR] unexpected git state'; exit 2;"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] git sync failed ^(exit %RC%^).
  goto end
)

echo.
echo [scope] resolve smart build scope
call powershell -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%\scripts\resolve-ragic-server-build-scope.ps1" -RepoDir "%REPO_DIR%" -BackendDir "%BACKEND_DIR%" -FrontendDir "%FRONTEND_DIR%" -FrontendDeployDir "%FRONTEND_DEPLOY%" -BeforeCommit "%BEFORE_SYNC%" -OutputCmd "%BUILD_SCOPE_CMD%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] build scope detection failed ^(exit %RC%^).
  goto end
)
call "%BUILD_SCOPE_CMD%"

:update
echo.
echo [2/6] backend: kill stale node + smart install/build
cd /d "%BACKEND_DIR%"

echo [preflight] validate Meeting and Dev AI provider env before stopping backend
call node scripts\validate-provider-env.js "%BACKEND_DIR%\.env"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] provider env preflight failed ^(exit %RC%^). Existing backend was not stopped.
  goto end
)
set "PROVIDER_PREFLIGHT_OK=1"

REM Kill port 3000 listener (= old backend) to release sqlite3 native binding
REM lock. Use Get-NetTCPConnection to target the listener PIDs, so we
REM do not nuke other node services running on this box (e.g. Ragic platform).
powershell -NoProfile -Command "$pids = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Where-Object { $_ -ne $null -and $_ -ne 0 }); if ($pids) { $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host '[INFO] stopped backend PID' $_ } }"

REM Use npm install, not npm ci. ci force-wipes node_modules; on Windows the
REM sqlite3 native binding is often held by antivirus / stale node process,
REM causing EPERM unlink. install is incremental, near-noop when lock unchanged,
REM and never wipes existing node_modules. --no-audit/--no-fund silences noise.
if not "%RUN_BACKEND_INSTALL%"=="1" (
  echo [skip] backend npm install
  goto backend_build
)
call npm install --no-audit --no-fund
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] backend npm install failed ^(exit %RC%^).
  goto end
)

:backend_build
echo.
echo [3/6] backend npm run build
if not "%RUN_BACKEND_BUILD%"=="1" (
  echo [skip] backend npm run build
  goto frontend_install
)
call npm run build
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] backend npm run build failed ^(exit %RC%^).
  goto end
)

:frontend_install
echo.
echo [4/6] frontend smart install/build
cd /d "%FRONTEND_DIR%"
if not "%RUN_FRONTEND_INSTALL%"=="1" (
  echo [skip] frontend npm install
  goto frontend_build
)
call npm install --no-audit --no-fund
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] frontend npm install failed ^(exit %RC%^).
  goto end
)

:frontend_build
echo.
echo [5/6] frontend npm run build
if not "%RUN_FRONTEND_BUILD%"=="1" (
  echo [skip] frontend npm run build
  goto frontend_sync
)
call npm run build
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] frontend npm run build failed ^(exit %RC%^).
  goto end
)

:frontend_sync
echo.
echo [sync] dist -^> %FRONTEND_DEPLOY%
if not "%RUN_FRONTEND_SYNC%"=="1" (
  echo [skip] frontend dist sync
  goto after_frontend_sync
)
robocopy "%FRONTEND_DIR%\dist" "%FRONTEND_DEPLOY%" /E /PURGE
set "RC=%ERRORLEVEL%"
REM robocopy: exit 0-7 = success (purge / extras / etc), 8+ = failure
if %RC% geq 8 (
  echo [ERROR] robocopy failed syncing dist ^(exit %RC%^).
  goto end
)
if defined FRONTEND_ENV_FINGERPRINT (
  > "%FRONTEND_DEPLOY%\.ragic-report-frontend-env.sha256" echo %FRONTEND_ENV_FINGERPRINT%
)

:after_frontend_sync
cd /d "%BACKEND_DIR%"

:start
title Report
echo.
if "%PROVIDER_PREFLIGHT_OK%"=="1" goto provider_preflight_ready
echo [preflight] validate Meeting and Dev AI provider env
call node scripts\validate-provider-env.js "%BACKEND_DIR%\.env"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [ERROR] provider env preflight failed ^(exit %RC%^).
  goto end
)

:provider_preflight_ready
echo [6/6] npm start
echo [INFO] UV_THREADPOOL_SIZE=%UV_THREADPOOL_SIZE%
echo [INFO] NODE_ENV=%NODE_ENV% RAGIC_WRITE_TARGET=%RAGIC_WRITE_TARGET%
if /i "%SERVE_FRONTEND_FROM_BACKEND%"=="true" (
  if not exist "%FRONTEND_STATIC_DIR%\index.html" (
    echo [ERROR] FRONTEND_STATIC_DIR missing index.html: %FRONTEND_STATIC_DIR%
    echo [ACTION] Run option 2 or 3 to build and sync frontend before starting.
    goto end
  )
)
cd /d "%BACKEND_DIR%"
call npm start

:end
echo.
pause
