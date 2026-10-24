@echo off
setlocal
rem ============================================================
rem  Codex 任务面板启动器
rem  - 项目目录由脚本自身位置推导（%~dp0），移动项目不会失效
rem  - Node 路径自动探测：先找 PATH，再找 WorkBuddy 托管版本
rem ============================================================

set "SCRIPT_DIR=%~dp0"
set "NODE_EXE="

rem 1) 先找 PATH 里的 node
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)

rem 2) 找不到就找 WorkBuddy 托管的 node（取版本号最大的那个）
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
    echo        请安装 Node.js 22+ 或确保 node 在 PATH 中。
    pause
    exit /b 1
)

echo 启动器目录: %SCRIPT_DIR%
echo Node: %NODE_EXE%
echo.

"%NODE_EXE%" "%SCRIPT_DIR%launch-panel.mjs"

endlocal
