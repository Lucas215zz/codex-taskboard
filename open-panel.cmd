@echo off
setlocal
rem ============================================================
rem  在默认浏览器中打开 Codex 任务面板
rem  - 项目目录由脚本自身位置推导（%~dp0），移动项目不会失效
rem ============================================================

set "SCRIPT_DIR=%~dp0"
set "NODE_EXE="

for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)

if not defined NODE_EXE (
    set "WB_VERSIONS=%USERPROFILE%\.workbuddy\binaries\node\versions"
    if exist "%WB_VERSIONS%" (
        for /f "delims=" %%d in ('dir /b /ad /o-n "%WB_VERSIONS%" 2^>nul') do (
            if not defined NODE_EXE (
                if exist "%WB_VERSIONS%\%%d\node.exe" set "NODE_EXE=%WB_VERSIONS%\%%d\node.exe"
            )
        )
    )
)

if not defined NODE_EXE (
    echo [错误] 找不到 Node.js
    pause
    exit /b 1
)

"%NODE_EXE%" "%SCRIPT_DIR%open-panel.mjs"

endlocal
