@echo off
setlocal

REM Backward-compatible entrypoint kept for existing Demo shortcuts.

for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
if errorlevel 1 exit /b 1

call npm run demo
exit /b %errorlevel%
