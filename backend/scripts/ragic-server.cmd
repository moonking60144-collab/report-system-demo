@echo off
setlocal

REM Backward-compatible entrypoint kept for existing Demo shortcuts.
REM The public repository only starts the synthetic backend.

call "%~dp0run-demo-backend.cmd"
exit /b %errorlevel%
