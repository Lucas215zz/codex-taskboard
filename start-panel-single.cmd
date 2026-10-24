@echo off
rem ============================================================
rem  Codex Taskboard - embed the panel INSIDE the Codex window
rem  ASCII only on purpose: cmd.exe reads .cmd as GBK, so UTF-8 Chinese
rem  comments turn into garbage and break line parsing.
rem
rem  This one MAY ask to restart Codex (the debug port cannot be added to
rem  an already running Codex). If you do not want that, use
rem  open-panel.cmd instead - it opens the panel in the browser and never
rem  touches Codex.
rem ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-panel-single.ps1"
