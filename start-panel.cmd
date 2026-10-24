@echo off
setlocal
rem ============================================================
rem  PowerShell 版启动器入口（兼容旧调用方式）
rem  - 项目目录由脚本自身位置推导（%~dp0），移动项目不会失效
rem ============================================================

set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-panel.ps1"

endlocal
