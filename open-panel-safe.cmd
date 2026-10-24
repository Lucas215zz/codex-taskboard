@echo off
rem ============================================================
rem  Codex Taskboard - one click launcher (recommended, safe)
rem  ASCII only on purpose: cmd.exe reads .cmd as GBK, so UTF-8 Chinese
rem  comments turn into garbage and break line parsing.
rem  - never closes or restarts Codex
rem  - starts the panel engine in background if needed
rem  - opens the panel in the default browser
rem  Log: .data\open-taskboard.log
rem ============================================================
wscript.exe "%~dp0open-taskboard.vbs"
