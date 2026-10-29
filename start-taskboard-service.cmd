@echo off
rem ============================================================
rem  Codex Taskboard - service-only launcher for logon autostart.
rem  ASCII only on purpose: cmd.exe reads .cmd as GBK.
rem  Starts the 47823 panel engine in the background and exits.
rem  Log: .data\autostart.log
rem ============================================================
setlocal

set "ROOT=%~dp0"
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE exit /b 1

cd /d "%ROOT%"
if not exist "%ROOT%.data" mkdir "%ROOT%.data"
"%NODE_EXE%" "%ROOT%open-panel-browser.mjs" --no-open >> "%ROOT%.data\autostart.log" 2>&1
endlocal