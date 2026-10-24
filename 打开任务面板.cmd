@echo off
rem ============================================================
rem  Codex Taskboard - one click launcher (recommended)
rem  ASCII only on purpose: cmd.exe reads .cmd as GBK, and UTF-8 Chinese
rem  comments turn into garbage that breaks line parsing.
rem  - never closes or restarts Codex
rem  - starts the panel engine in background if needed
rem  - opens the panel in the default browser
rem  - shows a message box on failure
rem  Log: .data\open-taskboard.log
rem ============================================================
wscript.exe "%~dp0open-taskboard.vbs"
