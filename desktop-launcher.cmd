@echo off
setlocal
rem ============================================================
rem  Codex 任务面板启动器（桌面入口）
rem  - 自动定位项目目录并调用项目内的 launch-panel.cmd
rem  - 项目整体移动后，只需保证下面的候选路径能命中即可
rem ============================================================

set "PANEL_CMD="
set "PROJECT_DIR="

rem 候选项目目录（按优先级）
rem 优先用纯英文路径：项目目录含中文会让 Node 的 import.meta.url 路径编码出乱码
for %%P in (
    "E:\github\dashi-taskboard-main"
    "E:\github\codex-taskboard\dashi-taskboard-main"
    "E:\github\codex-任务面板插件\dashi-taskboard-main"
) do (
    if not defined PANEL_CMD (
        if exist "%%~P\launch-panel.cmd" (
            set "PANEL_CMD=%%~P\launch-panel.cmd"
            set "PROJECT_DIR=%%~P"
        )
    )
)

if not defined PANEL_CMD (
    echo [错误] 找不到任务面板项目目录。
    echo.
    echo 已尝试的路径：
    echo   E:\github\dashi-taskboard-main
    echo   E:\github\codex-taskboard\dashi-taskboard-main
    echo   E:\github\codex-任务面板插件\dashi-taskboard-main
    echo.
    echo 如果你把项目移到了别处，请编辑本文件里的候选路径。
    pause
    exit /b 1
)

echo 项目目录: %PROJECT_DIR%
echo.

call "%PANEL_CMD%"

endlocal
